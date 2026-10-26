import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BaseSession } from '../src/session.ts'

const KB = 1024
const logger = { debug () {}, info () {}, warn () {}, error () {}, log () {} } as any

class TestSession extends BaseSession {
    acked = 0
    constructor () { super(logger) }
    async start (): Promise<void> { }
    resize (): void { }
    write (): void { }
    kill (): void { }
    async gracefullyKillProcess (): Promise<void> { }
    supportsWorkingDirectory (): boolean { return false }
    async getWorkingDirectory (): Promise<string|null> { return null }
    emit (data: Buffer): void { this.emitOutput(data, () => { this.acked += data.length }) }
}

/** Stands in for the terminal tab's write queue: each write completes when `release()` is called */
class FakeTerminal {
    queue: Promise<void> = Promise.resolve()
    queuedBytes = 0
    private releases: (() => void)[] = []

    constructor (session: BaseSession) {
        session.output$.subscribe(data => this.write(data))
        session.setOutputConsumer(() => this.queue)
    }

    write (data: string): void {
        this.queuedBytes += data.length
        this.queue = this.queue.then(() => new Promise<void>(resolve => this.releases.push(() => {
            this.queuedBytes -= data.length
            resolve()
        })))
    }

    async releaseAll (): Promise<void> {
        while (this.releases.length) {
            for (const release of this.releases.splice(0)) {
                release()
            }
            await settle()
        }
    }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

function shownSession (): TestSession {
    const session = new TestSession()
    session.releaseInitialDataBuffer()
    return session
}

describe('BaseSession backpressure', () => {
    it('acknowledges right away when no terminal consumes the output', () => {
        const session = shownSession()
        session.emit(Buffer.alloc(10))
        assert.equal(session.acked, 10)
    })

    it('acknowledges right away while the terminal has not been shown', () => {
        const session = new TestSession()
        new FakeTerminal(session)
        session.emit(Buffer.alloc(10))
        assert.equal(session.acked, 10)
    })

    it('acknowledges once the terminal has written the output', async () => {
        const session = shownSession()
        const terminal = new FakeTerminal(session)
        session.emit(Buffer.alloc(10))
        session.emit(Buffer.alloc(20))
        await settle()
        assert.equal(session.acked, 0)
        await terminal.releaseAll()
        assert.equal(session.acked, 30)
    })

    it('acknowledges output the middleware swallows', async () => {
        const session = shownSession()
        const terminal = new FakeTerminal(session)
        session.emit(Buffer.from('\x1b]9;notification\x07'))
        await terminal.releaseAll()
        assert.equal(session.acked, '\x1b]9;notification\x07'.length)
    })

    it('acknowledges even if the write fails', async () => {
        const session = shownSession()
        session.setOutputConsumer(() => Promise.reject(new Error('Frontend not ready')))
        session.emit(Buffer.alloc(10))
        await settle()
        assert.equal(session.acked, 10)
    })

    it('acknowledges a synchronous consumer failure without stalling output', () => {
        const session = shownSession()
        session.setOutputConsumer(() => { throw new Error('consumer failed') })
        session.emit(Buffer.alloc(10))
        assert.equal(session.acked, 10)
    })

    it('acknowledges pending output when the terminal lets go of the session', async () => {
        const session = shownSession()
        new FakeTerminal(session)
        session.emit(Buffer.alloc(10))
        session.setOutputConsumer(null)
        assert.equal(session.acked, 10)
        session.emit(Buffer.alloc(5))
        assert.equal(session.acked, 15)
    })

    it('acknowledges pending output when destroyed', async () => {
        const session = shownSession()
        const terminal = new FakeTerminal(session)
        session.open = true
        session.emit(Buffer.alloc(10))
        await session.destroy()
        assert.equal(session.acked, 10)
        // Writes completing later don't acknowledge twice
        await terminal.releaseAll()
        assert.equal(session.acked, 10)
    })

    it('bounds the output queued for a stalled terminal', async () => {
        // The main process' PTY queue: 100 KB chunks, paused at 500 KB unacknowledged
        const session = shownSession()
        const terminal = new FakeTerminal(session)
        const chunk = Buffer.alloc(100 * KB, 'x')
        const total = 200
        let sent = 0
        const produce = () => {
            while (sent < total && sent * chunk.length - session.acked <= 500 * KB) {
                session.emit(chunk)
                sent++
            }
        }

        produce()
        await settle()
        assert.ok(terminal.queuedBytes <= 600 * KB, `${terminal.queuedBytes / KB} KB queued for a stalled terminal`)

        while (sent < total || terminal.queuedBytes) {
            await terminal.releaseAll()
            produce()
            assert.ok(terminal.queuedBytes <= 600 * KB)
        }
        assert.equal(session.acked, total * chunk.length)
    })
})
