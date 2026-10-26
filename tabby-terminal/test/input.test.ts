import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getTUIKeySequence, preparePaste, shouldDelegateImagePaste } from '../src/input.ts'

const enter = { type: 'keydown', key: 'Enter', shiftKey: true, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 13 }

describe('TUI input', () => {
    it('delegates images to local AI tools while keeping remote and ordinary terminals on text paste', () => {
        assert.equal(shouldDelegateImagePaste('local', 'claude', true), true)
        assert.equal(shouldDelegateImagePaste('local', 'opencode', true), true)
        assert.equal(shouldDelegateImagePaste('local', 'claude', false), false)
        assert.equal(shouldDelegateImagePaste('ssh', 'claude', true), false)
        assert.equal(shouldDelegateImagePaste('local', undefined, true), false)
    })
    it('distinguishes Shift+Enter from Enter without submitting a prompt', () => {
        assert.equal(getTUIKeySequence(enter), '\x1b[13;2u')
        assert.equal(getTUIKeySequence({ ...enter, shiftKey: false }), null)
    })

    it('does not send an extra newline while the IME commits text', () => {
        assert.equal(getTUIKeySequence({ ...enter, isComposing: true }), null)
        assert.equal(getTUIKeySequence({ ...enter, keyCode: 229 }), null)
    })

    it('leaves other modified Enter keys and keyup to their existing handlers', () => {
        for (const change of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { type: 'keyup' }, { key: 'Tab' }]) {
            assert.equal(getTUIKeySequence({ ...enter, ...change }), null)
        }
    })

    it('keeps code indentation and trailing newlines in bracketed paste', () => {
        const text = '  中文\r\n    code\n\n'
        assert.equal(preparePaste(text, { bracketed: true, flatten: false, trim: true }), '\x1b[200~  中文\r    code\r\r\x1b[201~')
    })

    it('does not allow pasted text to escape the bracketed paste', () => {
        assert.equal(preparePaste('a\x1b[201~b', { bracketed: true, flatten: false, trim: false }), '\x1b[200~a[201~b\x1b[201~')
    })

    it('retains the explicit flatten and ordinary-shell trim options', () => {
        assert.equal(preparePaste('  one\r\ntwo\n', { bracketed: false, flatten: true, trim: true }), 'one two')
        assert.equal(preparePaste('  code\n  next\n', { bracketed: false, flatten: false, trim: true }), '  code\r  next')
        assert.equal(preparePaste('  value  ', { bracketed: false, flatten: false, trim: false }), '  value  ')
    })
})
