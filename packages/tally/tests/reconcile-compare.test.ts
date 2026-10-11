import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TallyStore, type StoredEntry } from '../src/store.js'
import { ledgerDaily, type LedgerDay } from '../src/reconcile/ledger.js'
import { compare } from '../src/reconcile/compare.js'
import type { BillRow } from '../src/reconcile/bill.js'

const sh = (iso: string) => Date.parse(iso + '+08:00')
const M = 1_000_000
let dir: string
let dbPath: string

function entry(id: string, at: number, route: string, model: string, over: Partial<StoredEntry> = {}): StoredEntry {
  const sessionId = id.split(':')[0]!
  return {
    id, sessionId, rootSessionId: sessionId, workspaceId: null, at, route, model,
    tokens: { input: M, cacheRead: 0, cacheWrite: 0, output: 0 }, usageKnown: true, deleted: false, ...over,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-tally-reconcile-'))
  dbPath = join(dir, 'tally.v1.sqlite')
  const store = TallyStore.open(dbPath)
  store.upsertEntry(entry('s1:1', sh('2026-10-14T00:30:00'), 'deepseek-official', 'deepseek-flash')) // off-peak: 1 CNY
  store.upsertEntry(entry('s1:2', sh('2026-10-14T15:00:00'), 'deepseek-official', 'deepseek-flash')) // peak: 2 CNY
  store.upsertEntry(entry('s1:3', sh('2026-10-14T10:00:00'), 'deepseek-account', 'deepseek-v4-pro')) // peak: 9 CNY
  store.upsertEntry(entry('s1:4', sh('2026-10-14T11:00:00'), 'foo', 'deepseek-flash')) // no price
  store.upsertEntry(entry('s1:5', sh('2026-10-15T09:30:00'), 'deepseek-official', 'deepseek-flash', { usageKnown: false }))
  store.close()
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const bill = (day: string, model: string, amount: string, currency: 'CNY' | 'USD' = 'CNY', line = 2): BillRow =>
  ({ day, model, amount, currency, line })

describe('ledgerDaily', () => {
  it('assigns entries to Beijing days, prices them and counts what it could not price', () => {
    const days = ledgerDaily({ dbPath, from: '2026-10-14', to: '2026-10-15', tz: 'Asia/Shanghai' })
    const flash = days.find(d => d.day === '2026-10-14' && d.model === 'deepseek-flash')!
    expect(flash).toMatchObject({ currency: 'CNY', amount: '3', requestCount: 3, unpricedCount: 1, unknownUsageCount: 0 })
    expect(days.find(d => d.day === '2026-10-14' && d.model === 'deepseek-v4-pro')).toMatchObject({ amount: '9', requestCount: 1 })
    expect(days.find(d => d.day === '2026-10-15')).toMatchObject({ currency: null, amount: '0', unknownUsageCount: 1 })
    expect(ledgerDaily({ dbPath, from: '2026-10-15', to: '2026-10-15', tz: 'Asia/Shanghai' }).map(d => d.day)).toEqual(['2026-10-15'])
  })

  it('never creates or rebuilds the ledger', () => {
    expect(() => ledgerDaily({ dbPath: join(dir, 'missing.sqlite'), from: '2026-10-14', to: '2026-10-14', tz: 'Asia/Shanghai' }))
      .toThrow('找不到账本数据库：' + join(dir, 'missing.sqlite'))
  })
})

describe('compare', () => {
  const ledger = (): LedgerDay[] => ledgerDaily({ dbPath, from: '2026-10-14', to: '2026-10-15', tz: 'Asia/Shanghai' })

  it('accepts differences within the 1% tolerance', () => {
    const r = compare(ledger(), [bill('2026-10-14', 'deepseek-flash', '3.01'), bill('2026-10-14', 'deepseek-v4-pro', '9')])
    const flash = r.rows.find(x => x.model === 'deepseek-flash' && x.day === '2026-10-14')!
    expect(flash).toMatchObject({ ours: '3', bill: '3.01', diff: '-0.01', diffRatio: '0.003322', withinTolerance: true })
  })

  it('flags a 2% difference and explains it with the unpriced count', () => {
    const r = compare(ledger(), [bill('2026-10-14', 'deepseek-flash', '3.0612')])
    const flash = r.rows.find(x => x.model === 'deepseek-flash' && x.day === '2026-10-14')!
    expect(flash.withinTolerance).toBe(false)
    expect(flash.hints).toContain('unpriced:1')
  })

  it('sums bill lines of the same day, model and currency before comparing', () => {
    const r = compare(ledger(), [bill('2026-10-14', 'deepseek-flash', '1'), bill('2026-10-14', 'deepseek-flash', '2', 'CNY', 3)])
    expect(r.rows.find(x => x.model === 'deepseek-flash' && x.day === '2026-10-14')).toMatchObject({ bill: '3', withinTolerance: true })
  })

  it('lists lines that exist on only one side as 100% differences', () => {
    const r = compare(ledger(), [bill('2026-10-14', 'deepseek-flash', '3'), bill('2026-10-14', 'deepseek-chat', '5')])
    expect(r.rows.find(x => x.model === 'deepseek-chat')).toMatchObject({ ours: null, bill: '5', diff: '-5', withinTolerance: false, hints: ['missingInLedger'] })
    expect(r.rows.find(x => x.model === 'deepseek-v4-pro')).toMatchObject({ ours: '9', bill: null, diff: '9', diffRatio: null, withinTolerance: false })
    expect(r.rows.find(x => x.model === 'deepseek-v4-pro')!.hints).toContain('missingInBill')
  })

  it('totals each currency separately', () => {
    const r = compare(ledger(), [bill('2026-10-14', 'deepseek-flash', '3'), bill('2026-10-14', 'gpt', '1', 'USD')])
    expect(r.totals.find(t => t.currency === 'CNY')).toMatchObject({ ours: '12', bill: '3', diff: '9' })
    expect(r.totals.find(t => t.currency === 'USD')).toMatchObject({ ours: '0', bill: '1', diff: '-1' })
    expect(r.totals.find(t => t.currency === 'CNY')!.outOfTolerance).toBeGreaterThan(0)
  })
})

describe('final review fixes: compare and ledger', () => {
  it('lists a day×model the ledger could not price even when the bill has no such line', () => {
    const r = compare(ledgerDaily({ dbPath, from: '2026-10-14', to: '2026-10-15', tz: 'Asia/Shanghai' }), [bill('2026-10-14', 'deepseek-flash', '3')])
    const unknown = r.rows.find(x => x.day === '2026-10-15')!
    expect(unknown).toMatchObject({ currency: null, ours: null, bill: null, withinTolerance: false })
    expect(unknown.hints).toEqual(['unknownUsage:1', 'missingInBill'])
    expect(r.unexplained).toEqual({ unpricedCount: 1, unknownUsageCount: 1 })
  })

  it('reconciles catalog aliases under their canonical model', () => {
    const store = TallyStore.open(dbPath)
    store.upsertEntry(entry('s2:1', sh('2026-10-16T15:00:00'), 'deepseek-official', 'deepseek-v4-flash'))
    store.upsertEntry(entry('s2:2', sh('2026-10-16T15:00:00'), 'deepseek-official', 'deepseek-v4-flash-vision-exp'))
    store.upsertEntry(entry('s2:3', sh('2026-10-16T15:00:00'), 'deepseek-official', 'deepseek-flash'))
    store.close()
    const days = ledgerDaily({ dbPath, from: '2026-10-16', to: '2026-10-16', tz: 'Asia/Shanghai' })
    expect(days).toEqual([expect.objectContaining({ model: 'deepseek-flash', amount: '6', requestCount: 3 })])
  })

  it('prices custom routes through the given route mapping', () => {
    const days = ledgerDaily({ dbPath, from: '2026-10-14', to: '2026-10-14', tz: 'Asia/Shanghai', providerRoutes: { foo: 'deepseek', 'deepseek-official': 'deepseek', 'deepseek-account': 'deepseek' } })
    expect(days.find(d => d.model === 'deepseek-flash')).toMatchObject({ amount: '5', unpricedCount: 0 })
  })
})
