import { createReadStream, promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as readline from 'readline'

// Claude Code's on-disk session format is not a public API. Everything here reads it
// leniently: unknown records are skipped and every field has a fallback.

export interface ClaudeSessionInfo {
    id: string
    file: string
    title: string
    /** Working directory recorded with the first prompt */
    cwd: string|null
    gitBranch: string|null
    entrypoint: string|null
    /** Epoch milliseconds of the newest prompt or reply */
    lastActivity: number
}

export type ClaudeSessionGroupKey = 'today'|'yesterday'|'week'|'earlier'

export interface ClaudeSessionGroup<T> {
    key: ClaudeSessionGroupKey
    sessions: T[]
}

/** Claude Code shortens longer project directory names and appends a hash */
const MAX_PROJECT_DIR_NAME = 200
const MAX_TITLE_LENGTH = 200
/** Bulky records the sidebar never needs; anything unknown is still parsed */
const SKIPPED_RECORDS = new Set([
    'api-request', 'api-request-blob', 'api-request-shape', 'attachment', 'atis-latch', 'cost-state',
    'file-history-delta', 'file-history-snapshot', 'mode', 'permission-mode', 'queue-operation', 'system', 'tools-used',
])

export function getClaudeConfigDir (): string {
    return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
}

export function encodeProjectPath (cwd: string): string {
    return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function normalizeTitle (value: unknown): string|null {
    if (typeof value !== 'string') {
        return null
    }
    const title = value.replace(/\s+/g, ' ').trim()
    if (!title) {
        return null
    }
    return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH) + '…' : title
}

/** Text the user typed, or null for tool results, slash commands and their output */
function promptText (content: unknown): string|null {
    let text: string|null = null
    if (typeof content === 'string') {
        text = content
    } else if (Array.isArray(content)) {
        const block = content.find(x => x?.type === 'text' && typeof x.text === 'string')
        text = block?.text ?? null
    }
    if (!text || /^\s*<(command-|local-command|bash-|system-reminder)/.test(text)) {
        return null
    }
    return normalizeTitle(text)
}

/**
 * Streams one session file and extracts what the sidebar shows.
 * Returns null for sessions without a single real exchange (e.g. only `/config` was run).
 */
export async function readSessionFile (file: string, mtimeMs?: number): Promise<ClaudeSessionInfo|null> {
    let customTitle: string|null = null
    let aiTitle: string|null = null
    let summary: string|null = null
    let lastPrompt: string|null = null
    let firstPrompt: string|null = null
    let cwd: string|null = null
    let gitBranch: string|null = null
    let entrypoint: string|null = null
    let lastActivity = 0
    let hasExchange = false

    const lines = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of lines) {
        // Most of a large session is API payloads; skip them without parsing
        const type = /"type":"([^"]+)"/.exec(line.slice(0, 512))?.[1]
        if (type && SKIPPED_RECORDS.has(type)) {
            continue
        }
        let record: any = null
        try {
            record = JSON.parse(line)
        } catch {
            continue
        }
        switch (record?.type) {
            case 'custom-title':
                customTitle = normalizeTitle(record.customTitle) ?? customTitle
                break
            case 'ai-title':
                aiTitle = normalizeTitle(record.aiTitle) ?? aiTitle
                break
            case 'summary':
                summary = normalizeTitle(record.summary) ?? summary
                break
            case 'last-prompt':
                lastPrompt = normalizeTitle(record.lastPrompt) ?? lastPrompt
                break
            case 'user':
            case 'assistant': {
                if (record.isSidechain) {
                    break
                }
                const timestamp = Date.parse(record.timestamp)
                if (!isNaN(timestamp)) {
                    lastActivity = Math.max(lastActivity, timestamp)
                }
                if (typeof record.gitBranch === 'string' && record.gitBranch) {
                    gitBranch = record.gitBranch
                }
                if (record.type === 'assistant') {
                    hasExchange = true
                    break
                }
                if (record.isMeta) {
                    break
                }
                cwd ??= typeof record.cwd === 'string' ? record.cwd : null
                entrypoint ??= typeof record.entrypoint === 'string' ? record.entrypoint : null
                const text = promptText(record.message?.content)
                if (text) {
                    hasExchange = true
                    firstPrompt ??= text
                }
                break
            }
        }
    }

    if (!hasExchange) {
        return null
    }
    if (!lastActivity) {
        lastActivity = mtimeMs ?? (await fs.stat(file)).mtimeMs
    }
    const id = path.basename(file, '.jsonl')
    return {
        id,
        file,
        title: customTitle ?? aiTitle ?? summary ?? lastPrompt ?? firstPrompt ?? id,
        cwd,
        gitBranch,
        entrypoint,
        lastActivity,
    }
}

async function directoryCandidates (cwd: string): Promise<string[]> {
    const result = [path.resolve(cwd)]
    try {
        const real = await fs.realpath(cwd)
        if (!result.includes(real)) {
            result.push(real)
        }
    } catch { }
    return result
}

export async function findProjectDirs (projectsDir: string, cwds: string[]): Promise<string[]> {
    const entries = await fs.readdir(projectsDir).catch(() => [] as string[])
    const dirs = new Set<string>()
    for (const cwd of cwds) {
        const encoded = encodeProjectPath(cwd)
        for (const entry of entries) {
            if (entry === encoded || encoded.length > MAX_PROJECT_DIR_NAME && entry.startsWith(encoded.slice(0, MAX_PROJECT_DIR_NAME))) {
                dirs.add(path.join(projectsDir, entry))
            }
        }
    }
    return [...dirs]
}

export function groupSessions<T extends { lastActivity: number }> (sessions: T[], now = new Date()): ClaudeSessionGroup<T>[] {
    const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).getTime()
    const today = day(0)
    const yesterday = day(-1)
    // Weeks start on Monday
    const week = day(-((now.getDay() + 6) % 7))
    const groups: ClaudeSessionGroup<T>[] = (['today', 'yesterday', 'week', 'earlier'] as ClaudeSessionGroupKey[]).map(key => ({ key, sessions: [] }))
    for (const session of [...sessions].sort((a, b) => b.lastActivity - a.lastActivity)) {
        const t = session.lastActivity
        groups[t >= today ? 0 : t >= yesterday ? 1 : t >= week ? 2 : 3].sessions.push(session)
    }
    return groups.filter(g => g.sessions.length)
}

/** Lists and caches the Claude Code sessions recorded for a directory */
export class ClaudeSessionIndex {
    private cache = new Map<string, { mtimeMs: number, size: number, info: ClaudeSessionInfo|null }>()

    constructor (public readonly claudeDir = getClaudeConfigDir()) { }

    get projectsDir (): string {
        return path.join(this.claudeDir, 'projects')
    }

    get liveSessionsDir (): string {
        return path.join(this.claudeDir, 'sessions')
    }

    async getProjectDirs (cwd: string): Promise<string[]> {
        return findProjectDirs(this.projectsDir, await directoryCandidates(cwd))
    }

    async list (cwd: string, options: { includeSDK?: boolean } = {}): Promise<ClaudeSessionInfo[]> {
        const cwds = await directoryCandidates(cwd)
        const files: string[] = []
        for (const dir of await findProjectDirs(this.projectsDir, cwds)) {
            try {
                files.push(...(await fs.readdir(dir)).filter(x => x.endsWith('.jsonl')).map(x => path.join(dir, x)))
            } catch { }
        }

        const infos = await Promise.all(files.map(file => this.read(file)))
        return infos
            .filter((x): x is ClaudeSessionInfo => !!x)
            // The directory name encoding is lossy (`/a-b` and `/a/b` collide)
            .filter(x => !x.cwd || cwds.includes(path.resolve(x.cwd)))
            .filter(x => options.includeSDK === true || !x.entrypoint?.startsWith('sdk'))
            .sort((a, b) => b.lastActivity - a.lastActivity)
    }

    /** The session a running `claude` process currently has open */
    async getLiveSessionId (pid: number): Promise<string|null> {
        try {
            const data = JSON.parse(await fs.readFile(path.join(this.liveSessionsDir, `${pid}.json`), 'utf8'))
            return data.pid === pid && typeof data.sessionId === 'string' ? data.sessionId : null
        } catch {
            return null
        }
    }

    private async read (file: string): Promise<ClaudeSessionInfo|null> {
        try {
            const stat = await fs.stat(file)
            const cached = this.cache.get(file)
            if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
                return cached.info
            }
            const info = await readSessionFile(file, stat.mtimeMs)
            this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info })
            return info
        } catch {
            this.cache.delete(file)
            return null
        }
    }
}

export function formatRelativeTime (time: number, now = Date.now()): string {
    const minutes = Math.floor((now - time) / 60000)
    if (minutes < 1) {
        return 'now'
    }
    if (minutes < 60) {
        return `${minutes}m`
    }
    if (minutes < 24 * 60) {
        return `${Math.floor(minutes / 60)}h`
    }
    const days = Math.floor(minutes / (24 * 60))
    if (days < 7) {
        return `${days}d`
    }
    return new Date(time).toLocaleDateString()
}
