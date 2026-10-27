// Real GPU regression tests for both published addon entries. No user sessions.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '../..')
const output = process.env.TABBY_WEBGL_RESULTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-webgl-test-'))
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'user-data'))
// Keep the test process alive between the CommonJS and ESM fixture windows.
app.on('window-all-closed', () => {})

async function exercise ({ root, esm, redrawSource, output }) {
    const assert = require('node:assert/strict')
    const { pathToFileURL } = require('node:url')
    const { createHash } = require('node:crypto')
    const { Terminal } = require(root + '/tabby-terminal/node_modules/@xterm/xterm')
    const addonPath = root + '/tabby-terminal/node_modules/@xterm/addon-webgl'
    const { WebglAddon } = esm ? await import(pathToFileURL(addonPath + '/lib/addon-webgl.mjs').href) : require(addonPath)
    const module = { exports: {} }
    new Function('module', 'exports', redrawSource)(module, module.exports)
    const { WebglAtlasRedraw, disposeWebglAddon } = module.exports
    const make = () => {
        const host = document.body.appendChild(document.createElement('div'))
        const term = new Terminal({ cols: 72, rows: 12, fontSize: 14, allowTransparency: true, cursorBlink: false, allowProposedApi: true })
        term.open(host)
        const addon = new WebglAddon(true)
        term.loadAddon(addon)
        return { term, addon, host, renderer: addon._renderer }
    }
    const destroy = pane => { disposeWebglAddon(pane.addon); pane.term.dispose(); pane.host.remove() }
    const write = (pane, data) => new Promise(resolve => pane.term.write(data, resolve))
    const paint = pane => pane.renderer.renderRows(0, pane.term.rows - 1)
    const signature = pane => createHash('sha256').update(pane.renderer._canvas.toDataURL()).digest('hex')
    const fullRedraw = pane => {
        pane.term._core._renderService.clear()
        pane.term._core._renderService.handleResize(pane.term.cols, pane.term.rows)
        paint(pane)
    }
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

    const a = make(), b = make()
    await write(a, 'static 中文 fixture')
    await write(b, 'active fixture')
    await settle()
    const atlas = a.renderer._charAtlas
    assert.equal(atlas, b.renderer._charAtlas, 'fixture must share an atlas')
    const Page = atlas.pages[0].constructor
    const glyphA = a.renderer._glyphRenderer.value
    const glyphB = b.renderer._glyphRenderer.value
    const uploads = []
    const uploaded = []
    const bind = glyphA._bindAtlasPageTexture.bind(glyphA)
    glyphA._bindAtlasPageTexture = (gl, current, slot) => {
        bind(gl, current, slot)
        uploads.push(slot)
        uploaded[slot] = current.pages[slot].canvas
    }
    const pages = Array.from({ length: 5 }, (_, i) => {
        const page = new Page(document, 32)
        page.addGlyph({ texturePage: i, texturePosition: { x: 0, y: 0 }, texturePositionClipSpace: { x: 0, y: 0 }, size: { x: 1, y: 1 }, sizeClipSpace: { x: 1 / 32, y: 1 / 32 }, offset: { x: 0, y: 0 } })
        return page
    })
    // Force the original fixture's collision values, but preserve the patched
    // global generation invariant for every subsequent production mutation.
    pages.forEach((page, i) => { page.version = 14 - i })
    Page.nextVersion = Math.max(Page.nextVersion || 0, 14)
    atlas._pages = pages
    atlas._activePages = [...pages]
    atlas._textureSize = 32
    atlas.constructor.maxAtlasPages = 5
    glyphA.setAtlas(atlas)
    glyphA.render(a.renderer._model)
    glyphA.beginFrame()
    glyphB.beginFrame()
    uploads.length = 0
    atlas._createNewPage()
    glyphA.render(a.renderer._model)
    assert(uploads.includes(0), 'shifted slot 0 must upload despite the old per-page collision')
    assert(atlas.pages.every((page, slot) => uploaded[slot] === page.canvas), 'all GPU slots must match the current pages')
    assert.equal(glyphA.beginFrame(), true)
    assert.equal(glyphA.beginFrame(), false, 'unchanged frames must not keep rebuilding the whole model')
    assert.equal(glyphB.beginFrame(), true, 'another renderer must independently observe the layout change')
    assert.equal(glyphB.beginFrame(), false)
    uploads.length = 0
    glyphA.render(a.renderer._model)
    assert.equal(uploads.length, 0, 'unchanged textures must not be re-uploaded')
    atlas.pages[0].currentRow.x = 1
    atlas.clearTexture()
    assert.equal(glyphA.beginFrame(), true)
    assert.equal(glyphB.beginFrame(), true, 'clearing the shared atlas must invalidate both renderers')
    assert.equal(glyphA.beginFrame(), false)
    assert.equal(glyphB.beginFrame(), false)
    // No group of four pages fits under this limit: eviction must replace the
    // old out-of-capacity/invalid merge path without leaving cached glyphs.
    atlas.constructor.maxAtlasPages = atlas.pages.length
    atlas.constructor.maxTextureSize = 32
    atlas._createNewPage()
    assert.equal(atlas.pages.length, 1)
    assert.equal(atlas._overflowSizePage, undefined)
    const deterministic = { collisionFixed: true, independentLayoutInvalidation: true, sharedClearInvalidation: true, unchangedFrameRebuilds: 0, unchangedTextureUploads: 0, capacityEviction: true }
    atlas.constructor.maxAtlasPages = undefined
    atlas.constructor.maxTextureSize = undefined
    destroy(a); destroy(b)

    // Real rasterization, merges, evictions and pixels: a static sibling must
    // remain correct while another terminal churns unique colored glyphs.
    const left = make(), right = make()
    await write(left, '\x1b[?25lSTATIC 中文 sibling\r\nKeep this pane unchanged')
    await write(right, '\x1b[?25l')
    await settle()
    const shared = left.renderer._charAtlas
    assert.equal(shared, right.renderer._charAtlas)
    shared.constructor.maxAtlasPages = 5
    shared.constructor.maxTextureSize = 1024
    shared._textureSize = 256
    fullRedraw(left)
    const expectedLeft = signature(left)
    let removals = 0, redraws = 0
    const recoveries = [left, right].map(pane => {
        pane.addon.onRemoveTextureAtlasCanvas(() => { removals++ })
        return new WebglAtlasRedraw(pane.addon, () => { redraws++; fullRedraw(pane) }, () => true)
    })
    for (let round = 0; round < 24; round++) {
        let data = '\x1b[H'
        for (let i = 0; i < 72 * 12; i++) {
            const n = round * 72 * 12 + i
            data += '\x1b[38;2;' + (64 + n % 192) + ';' + (64 + (n >> 4) % 192) + ';' + (64 + (n >> 8) % 192) + 'm' + String.fromCharCode(65 + i % 26)
        }
        await write(right, data)
        paint(right)
        paint(left)
        assert(shared.pages.length <= 5, 'atlas must stay within its sampler budget')
        await settle()
    }
    assert(removals > 0, 'stress must actually merge or evict pages')
    assert(redraws > 0 && redraws <= removals, `production recovery counts: ${JSON.stringify({ redraws, removals })}`)
    paint(left); paint(right)
    const before = [signature(left), signature(right)]
    const beforeImage = right.renderer._canvas.toDataURL()
    fullRedraw(left); fullRedraw(right)
    const after = [signature(left), signature(right)]
    if (before[1] !== after[1]) {
        require('node:fs').writeFileSync(output + '/before.png', Buffer.from(beforeImage.split(',')[1], 'base64'))
        require('node:fs').writeFileSync(output + '/after.png', Buffer.from(right.renderer._canvas.toDataURL().split(',')[1], 'base64'))
    }
    assert.deepEqual(before, after, 'automatic invalidation must match a clean full repaint after output stops')
    assert.equal(after[0], expectedLeft, 'static sibling pixels changed after shared atlas churn')
    for (const recovery of recoveries) recovery.dispose()
    const stress = { rounds: 24, coloredCells: 24 * 72 * 12, removals, redraws, pages: shared.pages.length, pixelsMatchCleanRepaint: true, staticSiblingPixelsPreserved: true }
    shared.constructor.maxAtlasPages = undefined
    shared.constructor.maxTextureSize = undefined
    destroy(left); destroy(right)
    return { entry: esm ? 'ESM' : 'CommonJS', deterministic, stress }
}

app.whenReady().then(async () => {
    const redrawSource = ts.transpileModule(fs.readFileSync(path.join(root, 'tabby-terminal/src/frontends/webglAddon.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
    const html = path.join(output, 'fixture.html')
    fs.writeFileSync(html, '<!doctype html><body style="margin:0"></body>')
    const results = []
    for (const esm of [false, true]) {
        const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } })
        try {
            await win.loadFile(html)
            results.push(await win.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify({ root, esm, redrawSource, output })})`))
        } finally {
            win.destroy()
        }
    }
    assert.equal(results.length, 2)
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n')
    console.log(JSON.stringify({ output, results }, null, 2))
    app.quit()
}).catch(error => { console.error(error); app.exit(1) })
setTimeout(() => { console.error('WebGL regression timeout'); app.exit(1) }, 45000).unref()
