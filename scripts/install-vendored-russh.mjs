#!/usr/bin/env node
// Replaces the published russh bindings with the ones in app/vendor/russh,
// built from russh-napi with sftp-request-timeout.patch applied.
import * as fs from 'fs'
import * as path from 'path'
import * as url from 'url'
import { createRequire } from 'module'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(import.meta.url)
const VENDORED_VERSION = '0.1.38+0.63.3'

const vendorDir = path.resolve(__dirname, '../app/vendor/russh')
const packageDir = path.resolve(__dirname, '../app/node_modules/russh')
const installedVersion = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version

const bindings = fs.readdirSync(vendorDir).filter(name => name.endsWith('.node'))
if (installedVersion !== VENDORED_VERSION) {
    console.warn(`russh ${installedVersion} is installed but the vendored bindings are for ${VENDORED_VERSION}; keeping the published ones`)
} else {
    for (const name of bindings) {
        const source = path.join(vendorDir, name)
        // A binding dyld refuses would break every SSH connection, so try the one for this machine first
        if (name === `russh.${process.platform}-${process.arch}.node`) {
            try {
                require(source)
            } catch (error) {
                console.warn(`russh: vendored ${name} does not load, keeping the published one: ${error.message}`)
                continue
            }
        }
        fs.copyFileSync(source, path.join(packageDir, name))
        console.log(`russh: installed vendored ${name}`)
    }
}
