import type { WebglAddon } from '@xterm/addon-webgl'

/** Defers atlas recovery until a synchronous merge/eviction has finished. */
export class WebglAtlasRedraw {
    private frame?: number
    private disposed = false
    private subscription: { dispose: () => void }

    constructor (
        addon: Pick<WebglAddon, 'onRemoveTextureAtlasCanvas'>,
        private redraw: () => void,
        private canRedraw: () => boolean,
        private requestFrame: (callback: FrameRequestCallback) => number = callback => requestAnimationFrame(callback),
        private cancelFrame: (frame: number) => void = frame => cancelAnimationFrame(frame),
    ) {
        this.subscription = addon.onRemoveTextureAtlasCanvas(() => {
            if (this.disposed || this.frame !== undefined) {
                return
            }
            this.frame = this.requestFrame(() => {
                this.frame = undefined
                if (!this.disposed && this.canRedraw()) {
                    this.redraw()
                }
            })
        })
    }

    cancel (): void {
        if (this.frame !== undefined) {
            this.cancelFrame(this.frame)
            this.frame = undefined
        }
    }

    dispose (): void {
        if (this.disposed) {
            return
        }
        this.disposed = true
        this.cancel()
        this.subscription.dispose()
    }
}

/**
 * Disposes a WebGL addon without leaking its renderer.
 *
 * @xterm/addon-webgl <= 0.19 never disposes WebglRenderer._cursorBlinkStateManager (it is not
 * registered for disposal), so its 600ms blink interval keeps the disposed renderer - and
 * through it the whole Terminal, its scrollback and the frontend - alive forever. Dispose it
 * explicitly first. Fixed upstream in addon-webgl 0.20 (xtermjs/xterm.js#5817); drop this then.
 */
export function disposeWebglAddon (addon: WebglAddon|undefined): void {
    try {
        (addon as any)?._renderer?._cursorBlinkStateManager?.dispose()
    } catch { }
    addon?.dispose()
}
