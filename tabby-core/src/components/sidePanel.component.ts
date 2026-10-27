import { Component, HostBinding, HostListener, Input, Type } from '@angular/core'

/** @hidden */
@Component({
    selector: 'side-panel',
    styleUrls: ['./sidePanel.component.scss'],
    templateUrl: './sidePanel.component.pug',
})
export class SidePanelComponent {
    @Input() component: Type<any>

    panelMinWidth = 200
    panelMaxWidth = 600
    panelIsResizing = false
    panelStartX = 0
    panelStartWidth = 0

    @HostBinding('style.width.px') panelWidth: number = parseInt(window.localStorage.sidePanelWidth ?? '300')

    startResize (event: MouseEvent): void {
        this.panelIsResizing = true
        this.panelStartX = event.clientX
        this.panelStartWidth = this.panelWidth
        event.preventDefault()
    }

    @HostListener('document:mousemove', ['$event'])
    onMouseMove (event: MouseEvent): void {
        if (!this.panelIsResizing) { return }
        const delta = event.clientX - this.panelStartX
        this.panelWidth = Math.min(Math.max(this.panelMinWidth, this.panelStartWidth + delta), this.panelMaxWidth)
        window.localStorage.sidePanelWidth = this.panelWidth
    }

    @HostListener('document:mouseup')
    stopResize (): boolean {
        this.panelIsResizing = false
        return true
    }
}
