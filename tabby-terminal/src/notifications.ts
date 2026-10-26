/** Prevent a ringing bell or a noisy program from flooding the OS notification centre. */
export class TerminalNotificationLimiter {
    private lastShown = -Infinity

    allow (now = performance.now()): boolean {
        if (now - this.lastShown < 1000) {
            return false
        }
        this.lastShown = now
        return true
    }
}
