// Regenerate the runtime entries when updating tabby-terminal's addon-webgl patch.
// patch-package installs these built entries; normal installs do not rebuild them.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import webpack from 'webpack'
import { minify } from 'terser'

const root = fileURLToPath(new URL('..', import.meta.url))
const addon = path.join(root, 'tabby-terminal/node_modules/@xterm/addon-webgl')
const xterm = path.join(root, 'tabby-terminal/node_modules/@xterm/xterm/src')

for (const esm of [false, true]) {
    const compiler = webpack({
        mode: 'production',
        target: ['web', 'es2020'],
        entry: path.join(addon, 'src/WebglAddon.ts'),
        // The published maps describe the unpatched bundle. Do not attach them.
        devtool: false,
        output: {
            path: path.join(addon, 'lib'),
            filename: esm ? 'addon-webgl.mjs' : 'addon-webgl.js',
            library: esm ? { type: 'module' } : { name: 'WebglAddon', type: 'umd' },
            globalObject: 'globalThis',
        },
        experiments: { outputModule: esm },
        resolve: {
            extensions: ['.ts', '.js'],
            alias: Object.fromEntries(['browser', 'common', 'vs'].map(name => [name, path.join(xterm, name)])),
        },
        module: {
            rules: [{
                test: /\.ts$/,
                loader: path.join(root, 'node_modules/ts-loader'),
                options: {
                    transpileOnly: true,
                    configFile: false,
                    compilerOptions: {
                        target: 'es2020', module: 'esnext', experimentalDecorators: true,
                        useDefineForClassFields: false, sourceMap: false,
                    },
                },
            }],
        },
        optimization: { minimize: false },
        plugins: [new webpack.BannerPlugin('Copyright (c) The xterm.js authors. MIT license; see ../LICENSE.\nTabby atlas backport; readable changes are in the patch src/ files.')],
    })
    try {
        const stats = await promisify(compiler.run.bind(compiler))()
        if (stats.hasErrors()) {
            throw new Error(stats.toString({ all: false, errors: true }))
        }
        console.log(stats.toString({ all: false, assets: true }))
        const entry = path.join(addon, 'lib', esm ? 'addon-webgl.mjs' : 'addon-webgl.js')
        const result = await minify(await readFile(entry, 'utf8'), { module: esm, format: { comments: /^!/ } })
        await writeFile(entry, result.code + '\n')
    } finally {
        await promisify(compiler.close.bind(compiler))()
    }
}
