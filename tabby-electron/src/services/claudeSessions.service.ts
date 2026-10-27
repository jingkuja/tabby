import * as fs from 'fs'
import { Injectable, NgZone, Type } from '@angular/core'
import { Observable, Subject, debounce, timer } from 'rxjs'
import { AppService, BaseTabComponent, NotificationsService, PartialProfile, SidePanelService, SplitTabComponent, TranslateService } from 'tabby-core'
import { LocalProfile, TerminalService, TerminalTabComponent } from 'tabby-local'
import { ClaudeSessionIndex, ClaudeSessionInfo } from '../claudeSessions'
import { AIToolShellProvider } from '../shells/ai'

const STATE_KEY = 'claudeSessionsPanel'
/** Session files grow with every streamed reply, so file changes are batched more coarsely */
const FILE_CHANGE_DELAY = 1000
const TAB_CHANGE_DELAY = 100

/** State behind the "CC session" side panel */
@Injectable({ providedIn: 'root' })
export class ClaudeSessionsService {
    /** Set by the module so this service does not import the component that injects it */
    panelComponent: Type<any>

    cwd: string|null = null
    sessions: ClaudeSessionInfo[] = []
    loading = false
    /** Session ID → the terminal tab running it */
    liveTabs = new Map<string, TerminalTabComponent>()
    activeSessionId: string|null = null

    get changed$ (): Observable<void> { return this.changed }

    private index = new ClaudeSessionIndex()
    private changed = new Subject<void>()
    private refreshRequested = new Subject<number>()
    private watchers: fs.FSWatcher[] = []
    private watchingProjectDir = false
    /** Fallback for Claude versions that do not register live sessions by PID */
    private launchedSessions = new WeakMap<BaseTabComponent, string>()

    constructor (
        private app: AppService,
        private sidePanel: SidePanelService,
        private terminal: TerminalService,
        private aiShells: AIToolShellProvider,
        private notifications: NotificationsService,
        private translate: TranslateService,
        private zone: NgZone,
    ) {
        this.refreshRequested.pipe(debounce(delay => timer(delay))).subscribe(() => this.refresh())
        app.tabsChanged$.subscribe(() => this.requestRefresh(TAB_CHANGE_DELAY))
        app.activeTabChange$.subscribe(() => this.requestRefresh(TAB_CHANGE_DELAY))
        sidePanel.changed$.subscribe(() => {
            if (!this.isOpen()) {
                this.stopWatching()
                this.saveState()
            }
        })
    }

    isOpen (cwd?: string|null): boolean {
        return this.sidePanel.isShown(this.panelComponent) && (cwd === undefined || cwd === this.cwd)
    }

    toggle (cwd: string|null): void {
        if (this.isOpen(cwd)) {
            this.close()
        } else {
            this.open(cwd)
        }
    }

    open (cwd: string|null): void {
        if (this.cwd !== cwd) {
            this.cwd = cwd
            this.sessions = []
        }
        this.sidePanel.show(this.panelComponent)
        this.saveState()
        this.watch()
        this.refresh()
    }

    close (): void {
        this.sidePanel.hide()
    }

    restoreState (): void {
        try {
            const state = JSON.parse(window.localStorage[STATE_KEY] ?? 'null')
            if (state?.open) {
                this.open(state.cwd ?? null)
            }
        } catch { }
    }

    requestRefresh (delay = FILE_CHANGE_DELAY): void {
        if (this.isOpen()) {
            this.refreshRequested.next(delay)
        }
    }

    async refresh (): Promise<void> {
        if (!this.isOpen()) {
            return
        }
        const cwd = this.cwd
        this.loading = true
        this.emitChanged()
        try {
            const [sessions] = await Promise.all([
                cwd ? this.index.list(cwd) : Promise.resolve([]),
                this.refreshLiveTabs(),
            ])
            if (cwd === this.cwd) {
                this.sessions = sessions
            }
        } catch (error) {
            console.error('Could not list Claude Code sessions:', error)
        } finally {
            this.loading = false
            this.emitChanged()
        }
    }

    /** Switches to the tab already running the session, or resumes it in a new one */
    async resume (session: ClaudeSessionInfo, fork = false): Promise<void> {
        const tab = this.liveTabs.get(session.id)
        if (tab && !fork) {
            this.selectTab(tab)
            return
        }
        const shell = await this.aiShells.getShell('claude', fork ? ['--resume', session.id, '--fork-session'] : ['--resume', session.id])
        if (!shell) {
            this.notifications.error(this.translate.instant('Claude Code is not available on this platform'))
            return
        }
        const profile: PartialProfile<LocalProfile> = {
            type: 'local',
            name: shell.name,
            options: {
                command: shell.command,
                args: shell.args ?? [],
                env: shell.env,
                shellType: shell.shellType ?? null,
                pauseAfterExit: shell.pauseAfterExit ?? false,
            },
        }
        const newTab = await this.terminal.openTab(profile, session.cwd ?? this.cwd)
        if (newTab && !fork) {
            this.launchedSessions.set(newTab, session.id)
            this.requestRefresh(TAB_CHANGE_DELAY)
        }
    }

    private selectTab (tab: BaseTabComponent): void {
        for (const top of this.app.tabs) {
            if (top === tab) {
                this.app.selectTab(top)
                return
            }
            if (top instanceof SplitTabComponent && top.getAllTabs().includes(tab)) {
                this.app.selectTab(top)
                top.focus(tab)
                return
            }
        }
    }

    private async refreshLiveTabs (): Promise<void> {
        const live = new Map<string, TerminalTabComponent>()
        let activeSessionId: string|null = null
        const active = this.app.activeTab instanceof SplitTabComponent ? this.app.activeTab.getFocusedTab() : this.app.activeTab
        for (const top of this.app.tabs) {
            const tabs = top instanceof SplitTabComponent ? top.getAllTabs() : [top]
            for (const tab of tabs) {
                if (!(tab instanceof TerminalTabComponent)) {
                    continue
                }
                const id = await this.getTabSessionId(tab)
                if (id) {
                    live.set(id, tab)
                    if (tab === active) {
                        activeSessionId = id
                    }
                }
            }
        }
        this.liveTabs = live
        this.activeSessionId = activeSessionId
    }

    /**
     * Claude Code registers each running instance in `sessions/<pid>.json`, which also follows
     * `/resume` and `/clear` inside the tab. The tab's process is `claude` itself for the Claude
     * Code profile and a shell with a `claude` child when it was started by hand.
     */
    private async getTabSessionId (tab: TerminalTabComponent): Promise<string|null> {
        const session = tab.session
        if (!session?.open) {
            return null
        }
        try {
            const pid = await session.getPID()
            if (pid) {
                const id = await this.index.getLiveSessionId(pid)
                if (id) {
                    return id
                }
            }
            for (const child of await session.getChildProcesses()) {
                const id = await this.index.getLiveSessionId(child.pid)
                if (id) {
                    return id
                }
            }
        } catch { }
        return this.launchedSessions.get(tab) ?? null
    }

    private async watch (): Promise<void> {
        this.stopWatching()
        const cwd = this.cwd
        const projectDirs = cwd ? await this.index.getProjectDirs(cwd) : []
        if (cwd !== this.cwd || !this.isOpen()) {
            return
        }
        this.watchingProjectDir = !!projectDirs.length
        this.addWatcher(this.index.projectsDir, () => {
            // The first session in a directory creates its project directory
            if (!this.watchingProjectDir) {
                this.watch()
            }
            this.requestRefresh()
        })
        this.addWatcher(this.index.liveSessionsDir, () => this.requestRefresh())
        for (const dir of projectDirs) {
            this.addWatcher(dir, () => this.requestRefresh())
        }
    }

    private addWatcher (dir: string, listener: () => void): void {
        try {
            this.watchers.push(fs.watch(dir, () => this.zone.run(listener)))
        } catch {
            // Directory does not exist (yet)
        }
    }

    private stopWatching (): void {
        for (const watcher of this.watchers) {
            watcher.close()
        }
        this.watchers = []
        this.watchingProjectDir = false
    }

    private saveState (): void {
        try {
            window.localStorage[STATE_KEY] = JSON.stringify({ open: this.isOpen(), cwd: this.cwd })
        } catch { }
    }

    private emitChanged (): void {
        this.zone.run(() => this.changed.next())
    }
}
