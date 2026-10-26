import assert from 'node:assert/strict'
import { it } from 'node:test'
import { TerminalNotificationLimiter } from '../src/notifications.ts'

it('limits notification bursts and permits a later attention request', () => {
    const limiter = new TerminalNotificationLimiter()
    assert.equal(limiter.allow(0), true)
    for (let now = 1; now < 1000; now++) {
        assert.equal(limiter.allow(now), false)
    }
    assert.equal(limiter.allow(1000), true)
    assert.equal(limiter.allow(1001), false)
    assert.equal(limiter.allow(3000), true)
})
