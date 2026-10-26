import { Injectable } from '@angular/core'
import { mkdir, readFile, writeFile, rename, unlink } from 'fs/promises'
import * as path from 'path'
import promiseIpc, { RendererProcessType } from 'electron-promise-ipc'
import { ConfigService, HostAppService, Platform } from 'tabby-core'
import { Shell, ShellProvider } from 'tabby-local'
import { ElectronService } from '../services/electron.service'
import { AITool, getAIToolCommand, OPENCODE_NOTIFICATION_CONFIG } from '../aiIntegration'

@Injectable()
export class AIToolShellProvider extends ShellProvider {
    constructor (
        private hostApp: HostAppService,
        private config: ConfigService,
        private electron: ElectronService,
    ) { super() }

    async provide (): Promise<Shell[]> {
        if (this.hostApp.platform !== Platform.macOS && this.hostApp.platform !== Platform.Linux) {
            return []
        }
        const shell = this.hostApp.platform === Platform.macOS
            ? await (promiseIpc as RendererProcessType).send('get-default-mac-shell') as string
            : process.env.SHELL ?? '/bin/sh'
        const notifications = !!(this.config.store.terminal.aiToolNotifications && this.config.store.terminal.desktopNotifications)
        const configPath = path.join(this.electron.app.getPath('userData'), 'integrations', 'opencode-tui.json')
        if (notifications) {
            await this.writeOpenCodeConfig(configPath)
        }
        return (['claude', 'opencode'] as AITool[]).map(tool => ({
            id: `ai-${tool}`,
            name: tool === 'claude' ? 'Claude Code' : 'OpenCode',
            command: shell,
            // Interactive login startup also loads PATH customisations made in .zshrc/.bashrc.
            args: ['-l', '-i', '-c', getAIToolCommand(tool, notifications, configPath)],
            env: { TABBY_AI_TOOL: tool },
            shellType: 'unix',
            pauseAfterExit: true,
        }))
    }

    private async writeOpenCodeConfig (target: string): Promise<void> {
        try {
            if (await readFile(target, 'utf8') === OPENCODE_NOTIFICATION_CONFIG) {
                return
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error
            }
        }
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
        try {
            await writeFile(temporary, OPENCODE_NOTIFICATION_CONFIG, { mode: 0o600 })
            await rename(temporary, target)
        } finally {
            await unlink(temporary).catch(() => undefined)
        }
    }
}
