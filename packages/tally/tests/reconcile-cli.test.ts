import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TallyStore } from '../src/store.js'
import { makeZip } from './support/zip.js'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
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

  it('prints 100% for lines present on one side only', () => {
    const r = run('reconcile', '--bill', writeBill('2026-10-14,deepseek-flash,2,CNY\n2026-10-14,other,1,CNY\n'), '--format', 'csv', '--db', db)
    expect(r.stdout).toMatch(/other.*差异 100\.00%/)
  })

  it('rejects --from after --to and impossible dates', () => {
    const bill = writeBill('2026-10-14,deepseek-flash,2,CNY\n')
    expect(run('reconcile', '--bill', bill, '--format', 'csv', '--db', db, '--from', '2026-10-15', '--to', '2026-10-14').status).toBe(2)
    const bad = run('reconcile', '--bill', bill, '--format', 'csv', '--db', db, '--from', '2026-13-45')
    expect(bad.status).toBe(2)
    expect(bad.stderr).toContain('2026-13-45')
  })

  it('says how many bill lines fall outside the chosen range', () => {
    const r = run('reconcile', '--bill', writeBill('2026-10-14,deepseek-flash,2,CNY\n2026-10-20,deepseek-flash,1,CNY\n'),
      '--format', 'csv', '--db', db, '--to', '2026-10-14')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('1 行不在对账日期范围内')
  })

  it('prints usage to stderr for an unknown command', () => {
    const r = run('nope')
    expect(r.status).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('用法')
  })

  it.skipIf(process.getuid?.() !== 0)('reads a ledger in a directory it cannot write to', () => {
    const ro = mkdtempSync(join(tmpdir(), 'dsh-tally-ro-'))
    const copy = join(ro, 'tally.v1.sqlite')
    writeFileSync(copy, require('node:fs').readFileSync(db))
    chmodSync(ro, 0o555)
    chmodSync(copy, 0o444)
    const bill = join(ro, '..', 'bill-ro.csv')
    writeFileSync(bill, '日期,模型,金额,币种\n2026-10-14,deepseek-flash,2,CNY\n')
    const r = spawnSync('runuser', ['-u', 'nobody', '--', process.execPath, cli, 'reconcile', '--bill', bill, '--format', 'csv', '--db', copy], { encoding: 'utf8' })
    chmodSync(ro, 0o755)
    rmSync(ro, { recursive: true, force: true })
    rmSync(bill, { force: true })
    expect(r.status, r.stderr).toBe(0)
  })
})

describe('dsh-tally reconcile with DeepSeek exports', () => {
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/deepseek-export/${name}`, import.meta.url), 'utf8')
  const COST = fixture('cost-2000-01-01_2000-01-02.csv')
  const USAGE = fixture('amount-2000-01-01_2000-01-02.csv')
  const zipOf = (files: { name: string; data: string }[]) => {
    const path = join(dir, 'export.zip')
    writeFileSync(path, makeZip(files.map(f => ({ ...f, deflate: true }))))
    return path
  }

  it('reads the official ZIP: the cost table once, Paid and Granted apart, request counts from the usage table, no account or key data', () => {
    const bill = zipOf([{ name: 'amount-2000-01-01_2000-01-02.csv', data: USAGE }, { name: 'cost-2000-01-01_2000-01-02.csv', data: COST }])
    const r = run('reconcile', '--bill', bill, '--db', db)
    expect(r.status).toBe(1) // the empty ledger has nothing for 2000: every line is out of tolerance
    expect(r.stdout).toContain('账单 0.84')
    expect(r.stdout).toContain('CNY  账本 0  账单 0.877')
    expect(r.stdout).toContain('Paid（充值余额）0.537')
    expect(r.stdout).toContain('Granted（赠金）0.34')
    expect(r.stdout).toContain('请求 16 次')
    expect(r.stdout).toContain('cost-2000-01-01_2000-01-02.csv')
    expect(r.stdout + r.stderr).not.toMatch(/DEMO_USER_NOT_REAL|DEMO_NOT_A_REAL_API_KEY|client-A|client-B/)
  })

  it('reads the cost CSV on its own and reports the split in JSON', () => {
    const bill = join(dir, 'cost.csv')
    writeFileSync(bill, COST)
    const r = run('reconcile', '--bill', bill, '--db', db, '--json')
    const out = JSON.parse(r.stdout) as { totals: { bill: string }[]; deepseek: { totals: { paid: string; granted: string; total: string; requestCount: number | null }[] } }
    expect(out.totals[0]!.bill).toBe('0.877')
    expect(out.deepseek.totals).toEqual([{ currency: 'CNY', paid: '0.537', granted: '0.34', total: '0.877', requestCount: null }])
    expect(r.stdout).not.toContain('DEMO_USER_NOT_REAL')
  })

  it('refuses the usage table as a bill, also with --format csv', () => {
    const bill = join(dir, 'amount.csv')
    writeFileSync(bill, USAGE)
    for (const extra of [[], ['--format', 'csv', '--currency', 'CNY']]) {
      const r = run('reconcile', '--bill', bill, '--db', db, ...extra)
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('用量表')
    }
  })

  it('names the problem with a ZIP that has no cost table or several', () => {
    let r = run('reconcile', '--bill', zipOf([{ name: 'amount.csv', data: USAGE }]), '--db', db)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('没有费用表')
    r = run('reconcile', '--bill', zipOf([{ name: 'cost-a.csv', data: COST }, { name: 'cost-b.csv', data: COST }]), '--db', db)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('多份费用表')
  })

  it('keys days in --tz', () => {
    const bill = join(dir, 'cost.csv')
    writeFileSync(bill, COST)
    const r = run('reconcile', '--bill', bill, '--db', db, '--tz', 'UTC', '--json')
    const out = JSON.parse(r.stdout) as { deepseek: { daily: { day: string }[] } }
    expect(out.deepseek.daily.map(d => d.day)).toEqual(['1999-12-31', '2000-01-01'])
  })
})
