import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAIToolCommand, getClaudeNotificationSettings, OPENCODE_NOTIFICATION_CONFIG } from '../src/aiIntegration.ts'
import { OSCProcessor } from '../../tabby-terminal/src/middleware/oscProcessing.ts'

describe('AI tool notification integration', { skip: process.platform === 'win32' }, () => {
    it('emits valid hook JSON and OSC events without a controlling terminal', () => {
        const settings = JSON.parse(getClaudeNotificationSettings())
        for (const event of ['Notification', 'Stop']) {
            const hook = settings.hooks[event][0].hooks[0]
            const result = JSON.parse(execFileSync('/bin/sh', ['-c', hook.command], { encoding: 'utf8' }))
            const parser = new OSCProcessor()
            const notifications: string[] = []
            parser.notificationRequested$.subscribe(value => notifications.push(value.body))
            parser.feedFromSession(Buffer.from(result.terminalSequence))
            assert.equal(notifications.length, 1)
            assert.match(notifications[0], event === 'Stop' ? /finished/ : /attention/)
            parser.close()
        }
    })

    it('passes the session settings as one argument through a real shell', t => {
        const dir = mkdtempSync(join(tmpdir(), 'tabby-ai-test-'))
        t.after(() => rmSync(dir, { recursive: true, force: true }))
        writeFileSync(join(dir, 'claude'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 })
        const output = execFileSync('/bin/sh', ['-c', getAIToolCommand('claude', true, '')], {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8',
        }).trim().split('\n')
        assert.equal(output[0], '--settings')
        assert.deepEqual(JSON.parse(output[1]), JSON.parse(getClaudeNotificationSettings()))
        assert.equal(output.length, 2)
    })

    it('quotes OpenCode configuration paths and respects explicit user overrides', t => {
        const dir = mkdtempSync(join(tmpdir(), 'tabby-ai-test-'))
        t.after(() => rmSync(dir, { recursive: true, force: true }))
        writeFileSync(join(dir, 'opencode'), '#!/bin/sh\nprintf "%s" "$OPENCODE_TUI_CONFIG"\n', { mode: 0o700 })
        const config = join(dir, "中文 path'$(echo unsafe).json")
        const command = getAIToolCommand('opencode', true, config)
        const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, OPENCODE_TUI_CONFIG: '' }
        assert.equal(execFileSync('/bin/sh', ['-c', command], { env, encoding: 'utf8' }), config)
        assert.equal(execFileSync('/bin/sh', ['-c', command], { env: { ...env, OPENCODE_TUI_CONFIG: '/custom/tui.jsonc' }, encoding: 'utf8' }), '/custom/tui.jsonc')
        assert.deepEqual(JSON.parse(OPENCODE_NOTIFICATION_CONFIG).attention, { enabled: true, notifications: true })
    })

    it('launches unmodified tools when integration is disabled', () => {
        assert.equal(getAIToolCommand('claude', false, ''), 'exec claude')
        assert.equal(getAIToolCommand('opencode', false, ''), 'exec opencode')
    })
})
