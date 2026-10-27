import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeSessionIndex, encodeProjectPath, groupSessions, readSessionFile } from '../src/claudeSessions.ts'
import { getAIToolCommand } from '../src/aiIntegration.ts'

const user = (cwd: string, content: unknown, extra: object = {}) => ({
    parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content },
    timestamp: '2026-10-26T10:00:00.000Z', entrypoint: 'cli', cwd, gitBranch: 'main', ...extra,
})
const assistant = (timestamp = '2026-10-26T10:01:00.000Z') => ({
    parentUuid: null, isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, timestamp,
})

function setup (t: { after: (fn: () => void) => void }) {
    const root = mkdtempSync(join(tmpdir(), 'tabby-claude-test-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const write = (cwd: string, id: string, records: object[], dirName = encodeProjectPath(cwd)) => {
        const dir = join(root, 'projects', dirName)
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `${id}.jsonl`)
        writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n')
        return file
    }
    return { root, write, index: new ClaudeSessionIndex(root) }
}

describe('Claude Code session index', () => {
    it('encodes project directories the way Claude Code does', () => {
        assert.equal(encodeProjectPath('/Users/nikin/project/github/tabby'), '-Users-nikin-project-github-tabby')
        assert.equal(encodeProjectPath('/a/b_c.d'), '-a-b-c-d')
    })

    it('prefers custom, then AI titles, then the last and first prompts', async t => {
        const { write } = setup(t)
        const cwd = '/work'
        const prompt = user(cwd, 'fix the   flaky\ntest')
        const base = [prompt, assistant()]
        assert.equal((await readSessionFile(write(cwd, 'a', [...base, { type: 'ai-title', aiTitle: 'Old' }, { type: 'ai-title', aiTitle: 'Flaky test' }, { type: 'custom-title', customTitle: 'Mine' }])))!.title, 'Mine')
        assert.equal((await readSessionFile(write(cwd, 'b', [...base, { type: 'ai-title', aiTitle: 'Flaky test' }, { type: 'last-prompt', lastPrompt: 'later' }])))!.title, 'Flaky test')
        assert.equal((await readSessionFile(write(cwd, 'c', [...base, { type: 'last-prompt', lastPrompt: 'later' }])))!.title, 'later')
        const info = (await readSessionFile(write(cwd, 'd', base)))!
        assert.equal(info.title, 'fix the flaky test')
        assert.equal(info.id, 'd')
        assert.equal(info.cwd, cwd)
        assert.equal(info.gitBranch, 'main')
        assert.equal(info.lastActivity, Date.parse('2026-10-26T10:01:00.000Z'))
    })

    it('skips sessions without a real exchange and ignores malformed lines', async t => {
        const { write } = setup(t)
        const cwd = '/work'
        const commandOnly = [
            user(cwd, '<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }),
            user(cwd, '<command-name>/config</command-name>'),
            { type: 'last-prompt', leafUuid: 'x' },
        ]
        assert.equal(await readSessionFile(write(cwd, 'empty', commandOnly)), null)

        const file = write(cwd, 'broken', [user(cwd, [{ type: 'text', text: 'hello' }]), assistant()])
        writeFileSync(file, '{not json\n' + '{"type":"api-request-blob","data":"' + 'x'.repeat(100000) + '"}\n', { flag: 'a' })
        assert.equal((await readSessionFile(file))!.title, 'hello')
    })

    it('lists sessions newest first, without SDK sessions or colliding directories', async t => {
        const { write, index } = setup(t)
        const cwd = join(tmpdir(), 'a-b')
        write(cwd, 'old', [user(cwd, 'old'), assistant('2026-10-20T10:00:00.000Z')])
        write(cwd, 'new', [user(cwd, 'new'), assistant('2026-10-26T10:00:00.000Z')])
        write(cwd, 'sdk', [user(cwd, 'sdk', { entrypoint: 'sdk-cli' }), assistant()])
        // `/tmp/a/b` encodes to the same directory name
        write(cwd, 'other', [user(join(tmpdir(), 'a', 'b'), 'other'), assistant()])
        assert.deepEqual((await index.list(cwd)).map(x => x.id), ['new', 'old'])
        assert.deepEqual((await index.list(cwd, { includeSDK: true })).map(x => x.id), ['sdk', 'new', 'old'])
        assert.deepEqual(await index.list(join(tmpdir(), 'nothing-here')), [])
    })

    it('finds shortened directories of long paths and refreshes changed files', async t => {
        const { write, index } = setup(t)
        const cwd = '/' + 'deep/'.repeat(50) + 'project'
        const file = write(cwd, 'long', [user(cwd, 'first'), assistant()], encodeProjectPath(cwd).slice(0, 200) + '-1a2b3c')
        assert.equal((await index.list(cwd))[0]?.title, 'first')

        writeFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: 'Renamed' }) + '\n', { flag: 'a' })
        utimesSync(file, new Date(), new Date(Date.now() + 5000))
        assert.equal((await index.list(cwd))[0]?.title, 'Renamed')
    })

    it('reads the session a running claude process has open', async t => {
        const { root, index } = setup(t)
        mkdirSync(join(root, 'sessions'))
        writeFileSync(join(root, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: 'abc', cwd: '/work' }))
        writeFileSync(join(root, 'sessions', '4243.json'), '{broken')
        assert.equal(await index.getLiveSessionId(4242), 'abc')
        assert.equal(await index.getLiveSessionId(4243), null)
        assert.equal(await index.getLiveSessionId(1), null)
    })

    it('groups sessions into today, yesterday, this week and earlier', () => {
        // Thursday
        const now = new Date(2026, 9, 29, 15, 0)
        const at = (day: number, hour = 12) => ({ id: `${day}-${hour}`, lastActivity: new Date(2026, 9, day, hour).getTime() })
        const groups = groupSessions([at(20), at(29, 9), at(28), at(26, 0), at(25, 23), at(29, 14)], now)
        assert.deepEqual(groups.map(g => [g.key, g.sessions.map(s => s.id)]), [
            ['today', ['29-14', '29-9']],
            ['yesterday', ['28-12']],
            ['week', ['26-0']],
            ['earlier', ['25-23', '20-12']],
        ])
        // On Monday, Sunday is still yesterday and nothing else is "this week"
        assert.deepEqual(groupSessions([at(25), at(24)], new Date(2026, 9, 26, 8)).map(g => g.key), ['yesterday', 'earlier'])
    })
})

describe('Claude Code resume command', { skip: process.platform === 'win32' }, () => {
    it('passes resume arguments through a real shell, with and without notification settings', t => {
        const dir = mkdtempSync(join(tmpdir(), 'tabby-ai-test-'))
        t.after(() => rmSync(dir, { recursive: true, force: true }))
        writeFileSync(join(dir, 'claude'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 })
        const run = (notifications: boolean) => execFileSync('/bin/sh', ['-c', getAIToolCommand('claude', notifications, '', ['--resume', 'it\'s-an-id'])], {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8',
        }).trim().split('\n')
        assert.deepEqual(run(false), ['--resume', 'it\'s-an-id'])
        const output = run(true)
        assert.equal(output[0], '--settings')
        assert.deepEqual(output.slice(2), ['--resume', 'it\'s-an-id'])
        assert.equal(getAIToolCommand('claude', false, ''), 'exec claude')
    })
})
