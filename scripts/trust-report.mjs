#!/usr/bin/env node
// Writes the dsh-trust-check results of every package's built `lib` into the root README,
// between the trust-report markers. `--check` only compares and exits 1 when the README is stale.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { auditPlugin, classifyRedLine, collectPlugin } from 'dsh-trust-check'

const root = fileURLToPath(new URL('..', import.meta.url))
const PACKAGES = [
  ['dsh-pricing-data', 'pricing-data'],
  ['dsh-tally-api', 'tally-api'],
  ['dsh-tally', 'tally'],
  ['dsh-tally-ui', 'tally-ui'],
  ['dsh-tally-balance-deepseek', 'balance-deepseek'],
]
const START = '<!-- trust-report:start -->'
const END = '<!-- trust-report:end -->'

function row([name, dir]) {
  const path = `${root}packages/${dir}/`
  const report = auditPlugin(collectPlugin(path, 'file:' + path))
  const list = (xs) => (xs.length === 0 ? '—' : xs.join('、'))
  const red = [...new Set(report.redLines.map(classifyRedLine))]
  const hosts = [...new Set(report.destinations.map(d => d.value))]
  return `| \`${name}\` | ${list([...report.capabilities].sort())} | ${list(red)} | ${list(hosts)} |`
}

const table = [
  '| 包 | 能力 | 红线 | 联网目标 |',
  '|---|---|---|---|',
  ...PACKAGES.map(row),
].join('\n')

const readmePath = `${root}README.md`
const readme = readFileSync(readmePath, 'utf8')
const newline = readme.includes('\r\n') ? '\r\n' : '\n'
const block = [START, table.replaceAll('\n', newline), END].join(newline)
const start = readme.indexOf(START)
const end = readme.indexOf(END)
if (start < 0 || end < start) {
  process.stderr.write('README.md 中缺少 trust-report 标记\n')
  process.exit(2)
}
const next = readme.slice(0, start) + block + readme.slice(end + END.length)
if (process.argv.includes('--check')) {
  if (next !== readme) {
    process.stdout.write('README 中的扫描结果已过期，请运行 pnpm trust:report\n')
    process.exit(1)
  }
} else {
  writeFileSync(readmePath, next)
}
