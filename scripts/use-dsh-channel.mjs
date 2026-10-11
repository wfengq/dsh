#!/usr/bin/env node
// Point the repo's exactly-pinned @deepseek-ai devDependencies at a dsh npm dist-tag (latest,
// alpha, ...) so CI can run the suite against that channel:
// - @deepseek-ai/dsh* packages are published in lockstep: they get the tag's dsh version;
// - framework packages (cordis, schemastery, cosmokit, cordis-plugin-*) version separately: they
//   get the minimum of the range that dsh itself (or, for cosmokit, cordis) declares — mixing
//   framework versions installs two cordis copies whose types and services do not match.
// Peer ranges and non-exact specs are left alone. The lockfile is removed after a change so the
// install resolves the whole graph afresh instead of keeping stale transitive versions.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const DSH = /^@deepseek-ai\/dsh(-.+)?$/

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'registry-version': { type: 'string' },
    framework: { type: 'string', multiple: true },
    root: { type: 'string', default: '.' },
  },
})
const tag = positionals[0]
if (!tag) {
  process.stderr.write('用法：node scripts/use-dsh-channel.mjs <dist-tag> [--registry-version <版本>] [--root <目录>]\n')
  process.exit(2)
}
const npmJson = (spec, field) =>
  JSON.parse(execFileSync('npm', ['view', spec, field, '--json'], { encoding: 'utf8' }) || 'null')
const version = values['registry-version'] ?? npmJson(`@deepseek-ai/dsh@${tag}`, 'version')

/** Framework package → declared range, from --framework flags (tests) or the registry. */
function frameworkRanges() {
  if (values.framework) {
    return Object.fromEntries(values.framework.map(f => [f.slice(0, f.indexOf('=')), f.slice(f.indexOf('=') + 1)]))
  }
  const dsh = npmJson(`@deepseek-ai/dsh@${version}`, 'dependencies') ?? {}
  const ranges = Object.fromEntries(Object.entries(dsh).filter(([n]) => n.startsWith('@deepseek-ai/') && !DSH.test(n)))
  const cordis = ranges['@deepseek-ai/cordis']
  if (cordis) {
    for (const [n, r] of Object.entries(npmJson(`@deepseek-ai/cordis@${minimum(cordis)}`, 'dependencies') ?? {})) {
      if (n.startsWith('@deepseek-ai/') && !(n in ranges)) ranges[n] = r
    }
  }
  return ranges
}

/** `~1.2.3-x` / `^1.2.3` / `1.2.3` → `1.2.3[-x]`. */
function minimum(range) {
  return range.replace(/^[~^=]/, '')
}
const root = resolve(values.root)

const manifests = [join(root, 'package.json')]
const packagesDir = join(root, 'packages')
if (existsSync(packagesDir)) {
  for (const dir of readdirSync(packagesDir)) {
    const path = join(packagesDir, dir, 'package.json')
    if (existsSync(path)) manifests.push(path)
  }
}

const frameworks = frameworkRanges()
let changed = 0
for (const path of manifests) {
  const json = JSON.parse(readFileSync(path, 'utf8'))
  const dev = json.devDependencies ?? {}
  let touched = false
  for (const [name, spec] of Object.entries(dev)) {
    if (!EXACT.test(spec)) continue
    const target = DSH.test(name) ? version : frameworks[name] !== undefined ? minimum(frameworks[name]) : undefined
    if (target !== undefined && target !== spec) {
      dev[name] = target
      changed++
      touched = true
    }
  }
  if (touched) writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
}
const lockfile = join(root, 'pnpm-lock.yaml')
if (changed > 0 && existsSync(lockfile)) rmSync(lockfile)
process.stdout.write(`dsh ${tag} → ${version}：改动 ${changed} 个依赖\n`)
