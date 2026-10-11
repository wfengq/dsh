import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TallyStore } from '../src/store.js'

const cli = fileURLToPath(new URL('../lib/cli.js', import.meta.url))
const sh = (iso: string) => Date.parse(iso + '+08:00')
let dir: string
let db: string

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
}

function writeBill(rows: string): string {
  const path = join(dir, 'bill.csv')
  writeFileSync(path, '日期,模型,金额,币种\n' + rows)
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-tally-cli-'))
  db = join(dir, 'tally.v1.sqlite')
  const store = TallyStore.open(db)
  store.upsertEntry({
    id: 's:1', sessionId: 's', rootSessionId: 's', workspaceId: null, at: sh('2026-10-14T15:00:00'),
    route: 'deepseek-official', model: 'deepseek-flash',
    tokens: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }, usageKnown: true, deleted: false,
  })
  store.close()
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('dsh-tally reconcile', () => {
  it('exits 0 with a summary when everything matches', () => {
    const r = run('reconcile', '--bill', writeBill('2026-10-14,deepseek-flash,2.00,CNY\n'), '--format', 'csv', '--db', db)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('汇总')
    expect(r.stdout).toContain('估算值，以账单为准')
    expect(r.stderr).not.toContain('ExperimentalWarning')
  })

  it('exits 1 and lists the line when a difference exceeds the tolerance', () => {
    const r = run('reconcile', '--bill', writeBill('2026-10-14,deepseek-flash,2.50,CNY\n'), '--format', 'csv', '--db', db)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('deepseek-flash')
  })

  it('prints the report as JSON', () => {
    const r = run('reconcile', '--bill', writeBill('2026-10-14,deepseek-flash,2,CNY\n'), '--format', 'csv', '--db', db, '--json')
    expect(r.status).toBe(0)
    const report = JSON.parse(r.stdout)
    expect(report.totals).toEqual([{ currency: 'CNY', ours: '2', bill: '2', diff: '0', outOfTolerance: 0 }])
  })

  it('exits 2 and names the file when the bill is missing', () => {
    const missing = join(dir, 'nope.csv')
    const r = run('reconcile', '--bill', missing, '--format', 'csv', '--db', db)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(missing)
  })

  it('exits 2 on bad arguments and prints usage for --help', () => {
    expect(run('reconcile', '--format', 'csv').status).toBe(2)
    const help = run('reconcile', '--help')
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('--bill')
  })

  it('maps bill model names, lists skipped lines and exits 1 because part of the bill was not reconciled', () => {
    const r = run('reconcile', '--bill', writeBill('2026-10-14,deepseek-chat,2,CNY\n2026-10-14,x,abc,CNY\n'),
      '--format', 'csv', '--db', db, '--model-map', 'deepseek-chat=deepseek-flash')
    expect(r.status).toBe(1)
    expect(r.stdout.split('\n')[0]).toContain('1 行无法解析')
    expect(r.stdout).toContain('第 3 行')
  })

  it('prints the skip reasons when no bill line could be parsed', () => {
    const r = run('reconcile', '--bill', writeBill('2026-10-14,x,abc,CNY\n'), '--format', 'csv', '--db', db)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('第 2 行')
  })

  it('accepts route mappings and names the mapping in the report', () => {
    const r = run('reconcile', '--bill', writeBill('2026-10-14,deepseek-flash,2,CNY\n'), '--format', 'csv', '--db', db, '--route', 'my-proxy=deepseek')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('my-proxy → deepseek')
  })

  it('reads price overrides from a JSON file', () => {
    const overrides = join(dir, 'overrides.json')
    writeFileSync(overrides, JSON.stringify([{ provider: 'deepseek-official', kind: 'manual', currency: 'CNY', models: { 'deepseek-flash': { input: '3', output: '1' } } }]))
    const r = run('reconcile', '--bill', writeBill('2026-10-14,deepseek-flash,3,CNY\n'), '--format', 'csv', '--db', db, '--overrides', overrides)
    expect(r.status).toBe(0)
  })
})
