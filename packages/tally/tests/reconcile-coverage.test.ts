import { describe, expect, it } from 'vitest'
import { loadCatalog } from 'dsh-pricing-data'
import { compare } from '../src/reconcile/compare.js'
import { pricesFromByModel } from '../src/reconcile/coverage.js'
import { formatReport } from '../src/reconcile/report.js'
import type { BillRow } from '../src/reconcile/bill.js'
import type { LedgerDay } from '../src/reconcile/ledger.js'

const bill = (day: string, amount: string, model = 'deepseek-flash'): BillRow => ({ day, model, amount, currency: 'CNY', line: 2 })
const priced = (day: string, amount: string): LedgerDay => ({
  day, model: 'deepseek-flash', currency: 'CNY', amount, requestCount: 1, unpricedCount: 0, unknownUsageCount: 0, holidayMissingCount: 0,
} as LedgerDay)

describe('price coverage', () => {
  it('starts each catalog model, and its aliases, on the day its first price takes effect', () => {
    const from = pricesFromByModel(loadCatalog(), 'Asia/Shanghai')
    expect(from['deepseek-flash']).toBe('2026-10-10')
    expect(from['deepseek-v4-flash']).toBe('2026-10-10')
  })

  it('leaves bill days before the prices out of the comparison, the totals and the exit verdict', () => {
    const r = compare([priced('2026-10-12', '0.37606884')], [bill('2026-10-06', '2.6300654'), bill('2026-10-12', '0.37631684')], '0.01', { pricesFrom: { 'deepseek-flash': '2026-10-10' } })
    const early = r.rows.find(x => x.day === '2026-10-06')!
    expect(early).toMatchObject({ compared: false, hints: ['beforePrices:2026-10-10'] })
    expect(r.rows.find(x => x.day === '2026-10-12')).toMatchObject({ compared: true, withinTolerance: true })
    expect(r.totals[0]).toMatchObject({ ours: '0.37606884', bill: '0.37631684', outOfTolerance: 0, notCompared: '2.6300654' })
    const text = formatReport(r)
    expect(text.split('\n')[0]).toBe('全部 1 行都在容差（1.00%）以内。')
    expect(text).toContain('价格数据开始之前的 1 行不参与比较')
    expect(text).toContain('2026-10-06  deepseek-flash  CNY  账单 2.6300654（价格数据从 2026-10-10 开始）')
  })

  it('still compares a model the catalog does not know', () => {
    const r = compare([], [bill('2026-10-06', '1', 'other-model')], '0.01', { pricesFrom: { 'deepseek-flash': '2026-10-10' } })
    expect(r.rows[0]).toMatchObject({ compared: true, withinTolerance: false })
  })
})
