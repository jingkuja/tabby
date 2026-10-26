import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FlowControl } from '../src/frontends/flowControl.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))
const chunk = 'x'.repeat(128 * 1024 + 1)

function stalledWriter () {
    const data: string[] = []
    const callbacks: (() => void)[] = []
    const flow = new FlowControl({ write: (value, callback) => {
        data.push(value)
        if (callback) { callbacks.push(callback) }
    } })
    return { flow, data, callbacks }
}

describe('xterm flow control', () => {
    it('waits at the high watermark and resumes after the low watermark', async () => {
        const { flow, data, callbacks } = stalledWriter()
        for (let i = 0; i < 11; i++) { await flow.write(chunk) }
        const pending = flow.write('last')
        await tick()
        assert.equal(data.length, 11)
        for (const callback of callbacks.splice(0, 7)) { callback() }
        await pending
        assert.equal(data.at(-1), 'last')
        flow.dispose()
    })

    it('releases blocked writes when a terminal is destroyed without further parser callbacks', async () => {
        const { flow, data, callbacks } = stalledWriter()
        for (let i = 0; i < 11; i++) { await flow.write(chunk) }
        const pending = flow.write('must not reach a disposed terminal')
        flow.dispose()
        await pending
        for (const callback of callbacks) { callback() }
        await flow.write('also disposed')
        assert.equal(data.length, 11)
    })

    it('counts UTF-8 bytes instead of UTF-16 string length', async () => {
        const { flow, callbacks } = stalledWriter()
        await flow.write('中'.repeat(50000))
        assert.equal(callbacks.length, 1)
        flow.dispose()
    })

    it('recovers after the underlying writer throws', async () => {
        let fail = true
        const flow = new FlowControl({ write: (_data, callback) => {
            if (fail) { throw new Error('writer failed') }
            callback?.()
        } })
        await assert.rejects(flow.write(chunk), /writer failed/)
        fail = false
        for (let i = 0; i < 20; i++) { await flow.write(chunk) }
        flow.dispose()
    })
})
