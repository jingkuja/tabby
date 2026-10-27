import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { disposeWebglAddon, WebglAtlasRedraw } from '../src/frontends/webglAddon.ts'

function redrawFixture () {
    let listener: (() => void)|undefined
    let active = true
    let redraws = 0
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    const recovery = new WebglAtlasRedraw(
        { onRemoveTextureAtlasCanvas: (callback: any) => {
            listener = callback
            return { dispose: () => { listener = undefined } }
        } },
        () => { redraws++ },
        () => active,
        callback => { frames.set(++nextFrame, callback); return nextFrame },
        id => { frames.delete(id) },
    )
    return {
        recovery, frames,
        emit: () => listener?.(),
        setActive: (value: boolean) => { active = value },
        get redraws () { return redraws },
        flush: () => {
            const pending = [...frames.values()]
            frames.clear()
            for (const callback of pending) { callback(0) }
        },
    }
}

describe('WebglAtlasRedraw', () => {
    it('defers and coalesces the four page removals from a merge into one redraw', () => {
        const fixture = redrawFixture()
        for (let i = 0; i < 4; i++) { fixture.emit() }
        assert.equal(fixture.redraws, 0)
        assert.equal(fixture.frames.size, 1)
        fixture.flush()
        assert.equal(fixture.redraws, 1)
        fixture.emit()
        fixture.flush()
        assert.equal(fixture.redraws, 2)
        fixture.recovery.dispose()
    })

    it('skips a pane hidden or replaced before the next frame', () => {
        const fixture = redrawFixture()
        fixture.emit()
        fixture.setActive(false)
        fixture.flush()
        assert.equal(fixture.redraws, 0)
        fixture.setActive(true)
        fixture.emit()
        fixture.flush()
        assert.equal(fixture.redraws, 1)
        fixture.recovery.dispose()
    })

    it('cancels pending work and unsubscribes when the addon is disposed', () => {
        const fixture = redrawFixture()
        fixture.emit()
        const alreadyQueued = [...fixture.frames.values()][0]
        fixture.recovery.dispose()
        fixture.recovery.dispose()
        fixture.emit()
        assert.equal(fixture.frames.size, 0)
        alreadyQueued(0)
        assert.equal(fixture.redraws, 0)
    })

    it('cancels work on detach while allowing later merges after reattach', () => {
        const fixture = redrawFixture()
        fixture.emit()
        fixture.recovery.cancel()
        assert.equal(fixture.frames.size, 0)
        fixture.emit()
        fixture.flush()
        assert.equal(fixture.redraws, 1)
        fixture.recovery.dispose()
    })
})

function fakeAddon (calls: string[], renderer: unknown = {
    _cursorBlinkStateManager: { dispose: () => calls.push('blink manager') },
}): any {
    return { _renderer: renderer, dispose: () => calls.push('addon') }
}

describe('disposeWebglAddon', () => {
    it('disposes the renderer\'s cursor blink manager before the addon', () => {
        // addon-webgl <= 0.19 never disposes it, and its blink interval keeps the whole
        // terminal of every closed tab alive.
        const calls: string[] = []
        disposeWebglAddon(fakeAddon(calls))
        assert.deepEqual(calls, ['blink manager', 'addon'])
    })

    it('still disposes the addon when the renderer internals are missing or throw', () => {
        const calls: string[] = []
        disposeWebglAddon(fakeAddon(calls, null))
        disposeWebglAddon(fakeAddon(calls, {}))
        disposeWebglAddon(fakeAddon(calls, { _cursorBlinkStateManager: { dispose: () => { throw new Error('boom') } } }))
        assert.deepEqual(calls, ['addon', 'addon', 'addon'])
    })

    it('accepts a missing addon', () => {
        disposeWebglAddon(undefined)
    })

    it('reaches internals that the installed @xterm/addon-webgl still has', () => {
        // The workaround goes through private fields. If an upgrade renames them it would
        // silently stop disposing the timer - fail here instead.
        const require = createRequire(import.meta.url)
        const source = readFileSync(require.resolve('@xterm/addon-webgl'), 'utf8')
        assert.match(source, /this\._renderer\s*=/, 'WebglAddon no longer has _renderer')
        assert.match(source, /this\._cursorBlinkStateManager\s*=/, 'WebglRenderer no longer has _cursorBlinkStateManager')
    })
})
