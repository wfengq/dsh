#!/usr/bin/env node
// Usage: node scripts/check-client-bundle.mjs <bundle.js>
//
// A dsh browser bundle may only `require()` modules from the host's shared module table; any
// other module must be inlined, because the client module loader cannot answer it at runtime.
// Exits with code 1 and lists the offending module names when the bundle requires anything else.
// The bundle and its source map are published, so they must not carry this machine's checkout path
// either; that fails the check too.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHARED_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: check-client-bundle.mjs <bundle.js>')
  process.exit(2)
}

const source = readFileSync(file, 'utf8')
const requested = new Set()
for (const match of source.matchAll(/\brequire\(\s*(["'`])([^"'`]+)\1\s*\)/g)) requested.add(match[2])

const forbidden = [...requested].filter(name => !SHARED_MODULES.has(name)).sort()
if (forbidden.length > 0) {
  console.error(`${file}: requires modules outside the shared module table:`)
  for (const name of forbidden) console.error(`  ${name}`)
  process.exit(1)
}
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkoutPaths = [checkout, checkout.replaceAll('\\', '/'), JSON.stringify(checkout).slice(1, -1)]
const leaks = [file, `${file}.map`].filter(path => existsSync(path)
  && checkoutPaths.some(spelling => readFileSync(path, 'utf8').includes(spelling)))
if (leaks.length > 0) {
  console.error(`contains the absolute checkout path ${checkout}:`)
  for (const path of leaks) console.error(`  ${path}`)
  process.exit(1)
}
console.log(`${file}: ok (${[...requested].sort().join(', ') || 'no requires'})`)
