import { Injectable } from '@angular/core'
import { BaseTabComponent, MenuItemOptions, TabContextMenuItemProvider, TranslateService } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'
import { ClaudeSessionsService } from './services/claudeSessions.service'

/** @hidden */
@Injectable()
export class ClaudeSessionsContextMenu extends TabContextMenuItemProvider {
    weight = 0

    constructor (
        private claude: ClaudeSessionsService,
        private translate: TranslateService,
    ) {
        super()
    }

    async getItems (tab: BaseTabComponent, tabHeader?: boolean): Promise<MenuItemOptions[]> {
        // Split tabs are asked again for their focused pane
        if (!tabHeader || !(tab instanceof TerminalTabComponent) || process.platform === 'win32') {
            return []
        }
        const cwd = await tab.session?.getWorkingDirectory() ?? null
        return [
            {
                label: this.translate.instant('CC session'),
                type: 'checkbox',
                checked: this.claude.isOpen(cwd),
                click: () => this.claude.toggle(cwd),
            },
        ]
    }
}
