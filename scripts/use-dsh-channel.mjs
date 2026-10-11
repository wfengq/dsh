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
if (typeof version !== 'string' || !EXACT.test(version)) fail(2, `无法确定 dsh ${tag} 的版本：${JSON.stringify(version)}`)

function fail(code, message) {
  process.stderr.write(message + '\n')
  process.exit(code)
}

/** Semver precedence, prerelease-aware (1.2.3-alpha.1 < 1.2.3); returns -1, 0 or 1. */
function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = v.split(/-(.*)/s)
    return { core: core.split('.').map(Number), pre: pre === undefined ? [] : pre.split('.') }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/** Does `v` satisfy a `>=A <B` range (the only form our peer ranges use)? `undefined` for other forms. */
function inRange(v, range) {
  const m = /^>=\s*(\S+)\s+<\s*(\S+)$/.exec(range.trim())
  if (!m) return undefined
  return compareVersions(v, m[1]) >= 0 && compareVersions(v, m[2]) < 0
}

/** Framework package → declared range, from --framework flags (tests) or the registry. */
function frameworkRanges() {
  if (values.framework) {
    return Object.fromEntries(values.framework.map(f => [f.slice(0, f.indexOf('=')), f.slice(f.indexOf('=') + 1)]))
  }
  const dsh = npmJson(`@deepseek-ai/dsh@${version}`, 'dependencies') ?? {}
  const ranges = Object.fromEntries(Object.entries(dsh).filter(([n]) => n.startsWith('@deepseek-ai/') && !DSH.test(n)))
  const cordis = ranges['@deepseek-ai/cordis']
  if (cordis) {
    for (const [n, r] of Object.entries(npmJson(`@deepseek-ai/cordis@${minimum('@deepseek-ai/cordis', cordis)}`, 'dependencies') ?? {})) {
      if (n.startsWith('@deepseek-ai/') && !(n in ranges)) ranges[n] = r
    }
  }
  return ranges
}

/** `~1.2.3-x` / `^1.2.3` / `1.2.3` → `1.2.3[-x]`; any other range form is refused. */
function minimum(name, range) {
  const v = range.trim().replace(/^[~^=]/, '')
  if (!EXACT.test(v)) fail(2, `无法从 ${name} 的版本范围 ${JSON.stringify(range)} 确定一个版本`)
  return v
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

// The channel must fall inside the dsh peer ranges our packages publish, or CI would pass on a
// combination real installs reject.
const outside = []
for (const path of manifests) {
  for (const [name, range] of Object.entries(JSON.parse(readFileSync(path, 'utf8')).peerDependencies ?? {})) {
    if (DSH.test(name) && inRange(version, range) === false) outside.push(`${name} ${range}（${path}）`)
  }
}
if (outside.length > 0) fail(3, `dsh ${tag} 的版本 ${version} 不在本仓库声明的 peer 范围内：\n  ${outside.join('\n  ')}`)

const frameworks = frameworkRanges()
for (const [name, range] of Object.entries(frameworks)) frameworks[name] = minimum(name, range)

let changed = 0
for (const path of manifests) {
  const json = JSON.parse(readFileSync(path, 'utf8'))
  const dev = json.devDependencies ?? {}
  let touched = false
  for (const [name, spec] of Object.entries(dev)) {
    if (!EXACT.test(spec)) continue
    const target = DSH.test(name) ? version : frameworks[name]
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
