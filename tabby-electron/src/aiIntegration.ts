export type AITool = 'claude'|'opencode'

export function quotePOSIX (value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Session-scoped settings merge with Claude's settings without editing the user's files. */
export function getClaudeNotificationSettings (): string {
    const hook = (body: string) => ({
        type: 'command',
        command: `printf '%s\\n' ${quotePOSIX(JSON.stringify({ terminalSequence: `\x1b]777;notify;Claude Code;${body}\x07` }))}`,
        timeout: 5,
    })
    return JSON.stringify({
        hooks: {
            Notification: [{ hooks: [hook('Needs your attention')] }],
            Stop: [{ hooks: [hook('Task finished')] }],
        },
    })
}

export const OPENCODE_NOTIFICATION_CONFIG = JSON.stringify({
    $schema: 'https://opencode.ai/tui.json',
    attention: { enabled: true, notifications: true },
}, null, 2) + '\n'

/** @param claudeArgs extra arguments for `claude`, such as `--resume <id>` */
export function getAIToolCommand (tool: AITool, notifications: boolean, opencodeConfigPath: string, claudeArgs: string[] = []): string {
    if (tool === 'claude') {
        const args = notifications ? ['--settings', getClaudeNotificationSettings(), ...claudeArgs] : claudeArgs
        return ['exec claude', ...args.map(quotePOSIX)].join(' ')
    }
    if (!notifications) {
        return 'exec opencode'
    }
    // An explicitly selected TUI configuration belongs to the user and takes precedence.
    return `if [ -z "\${OPENCODE_TUI_CONFIG:-}" ]; then export OPENCODE_TUI_CONFIG=${quotePOSIX(opencodeConfigPath)}; fi; exec opencode`
}
