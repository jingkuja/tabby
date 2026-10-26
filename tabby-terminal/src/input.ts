/** Modified Enter must remain distinct from Enter for multiline TUI prompts. */
export function getTUIKeySequence (event: Pick<KeyboardEvent, 'type'|'key'|'shiftKey'|'altKey'|'ctrlKey'|'metaKey'|'isComposing'|'keyCode'>): string|null {
    if (event.isComposing || event.keyCode === 229) {
        return null
    }
    if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        return '\x1b[13;2u'
    }
    return null
}

export function preparePaste (text: string, options: { bracketed: boolean, flatten: boolean, trim: boolean }): string {
    let data = text.replace(/\r\n|\n/g, '\r')
    if (options.flatten) {
        data = data.replace(/[\r\n]+/g, ' ')
    }
    if (options.bracketed) {
        // A pasted escape must not be able to terminate the bracketed paste early.
        return `\x1b[200~${data.replace(/\x1b/g, '')}\x1b[201~`
    }
    if (options.trim) {
        data = data.includes('\r') ? data.trimEnd() : data.trim()
    }
    return data
}

/** Remote tools cannot read the local machine's clipboard. */
export function shouldDelegateImagePaste (profileType: string, tool: unknown, hasImage: boolean): boolean {
    return profileType === 'local' && (tool === 'claude' || tool === 'opencode') && hasImage
}
