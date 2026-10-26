interface TerminalWriter {
    write: (data: string, callback?: () => void) => void
}

/** Keeps xterm's parser queue bounded while allowing small writes to share a callback. */
export class FlowControl {
    private pendingCallbacks = 0
    private bytesWritten = 0
    private blocked: Promise<void>|null = null
    private unblock?: () => void
    private disposed = false

    constructor (private xterm: TerminalWriter) { }

    async write (data: string): Promise<void> {
        if (this.blocked) {
            await this.blocked
        }
        if (this.disposed) {
            return
        }
        this.bytesWritten += Buffer.byteLength(data)
        if (this.bytesWritten <= 128 * 1024) {
            this.xterm.write(data)
            return
        }
        this.bytesWritten = 0
        this.pendingCallbacks++
        if (this.pendingCallbacks > 10) {
            this.blocked = new Promise(resolve => { this.unblock = resolve })
        }
        let completed = false
        const complete = () => {
            if (this.disposed || completed) {
                return
            }
            completed = true
            this.pendingCallbacks--
            if (this.pendingCallbacks < 5) {
                this.release()
            }
        }
        try {
            this.xterm.write(data, complete)
        } catch (error) {
            complete()
            throw error
        }
    }

    dispose (): void {
        this.disposed = true
        this.release()
    }

    private release (): void {
        this.blocked = null
        this.unblock?.()
        this.unblock = undefined
    }
}
