import * as os from 'os'
import { Component } from '@angular/core'
import { BaseComponent, PlatformService, TranslateService } from 'tabby-core'
import { ClaudeSessionGroup, ClaudeSessionGroupKey, ClaudeSessionInfo, formatRelativeTime, groupSessions } from '../claudeSessions'
import { ClaudeSessionsService } from '../services/claudeSessions.service'

const COLLAPSED_KEY = 'claudeSessionGroupCollapsed'

/** @hidden */
@Component({
    selector: 'claude-sessions-panel',
    templateUrl: './claudeSessionsPanel.component.pug',
    styleUrls: ['./claudeSessionsPanel.component.scss'],
})
export class ClaudeSessionsPanelComponent extends BaseComponent {
    filter = ''
    groups: ClaudeSessionGroup<ClaudeSessionInfo>[] = []
    collapsed: Partial<Record<ClaudeSessionGroupKey, boolean>> = {}
    groupLabels: Record<ClaudeSessionGroupKey, string> = {
        today: this.translate.instant('Today'),
        yesterday: this.translate.instant('Yesterday'),
        week: this.translate.instant('This week'),
        earlier: this.translate.instant('Earlier'),
    }

    constructor (
        public claude: ClaudeSessionsService,
        private platform: PlatformService,
        private translate: TranslateService,
    ) {
        super()
        try {
            this.collapsed = JSON.parse(window.localStorage[COLLAPSED_KEY] ?? '{}')
        } catch { }
    }

    ngOnInit (): void {
        this.update()
        this.subscribeUntilDestroyed(this.claude.changed$, () => this.update())
    }

    get displayCwd (): string {
        const cwd = this.claude.cwd ?? ''
        const home = os.homedir()
        return cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
    }

    update (): void {
        const q = this.filter.trim().toLowerCase()
        const sessions = q ? this.claude.sessions.filter(s => s.title.toLowerCase().includes(q) || s.gitBranch?.toLowerCase().includes(q)) : this.claude.sessions
        this.groups = groupSessions(sessions)
    }

    toggleGroup (key: ClaudeSessionGroupKey): void {
        this.collapsed[key] = !this.collapsed[key]
        try {
            window.localStorage[COLLAPSED_KEY] = JSON.stringify(this.collapsed)
        } catch { }
    }

    relativeTime (session: ClaudeSessionInfo): string {
        return formatRelativeTime(session.lastActivity)
    }

    exactTime (session: ClaudeSessionInfo): string {
        return new Date(session.lastActivity).toLocaleString()
    }

    sessionContextMenu (session: ClaudeSessionInfo, event: MouseEvent): void {
        event.preventDefault()
        this.platform.popupContextMenu([
            {
                type: 'normal',
                label: this.claude.liveTabs.has(session.id) ? this.translate.instant('Switch to tab') : this.translate.instant('Resume'),
                click: () => this.claude.resume(session),
            },
            {
                type: 'normal',
                label: this.translate.instant('Resume as a new session (fork)'),
                click: () => this.claude.resume(session, true),
            },
            { type: 'separator' },
            {
                type: 'normal',
                label: this.translate.instant('Copy session ID'),
                click: () => this.platform.setClipboard({ text: session.id }),
            },
        ], event)
    }

    trackBySession (_index: number, session: ClaudeSessionInfo): string {
        return session.id
    }
}
