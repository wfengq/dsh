import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { pickBillParser } from '../src/reconcile/bill.js'
import { genericCsv } from '../src/reconcile/generic-csv.js'
import {
  dayKeyOf, deepseekCost, isDeepSeekUsageTable, loadDeepSeekExport, parseDeepSeekUsage, summarizeDeepSeek,
} from '../src/reconcile/deepseek.js'
import { readZip } from '../src/reconcile/zip.js'
import { makeZip } from './support/zip.js'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/deepseek-export/${name}`, import.meta.url), 'utf8')
const COST = fixture('cost-2000-01-01_2000-01-02.csv')
const USAGE = fixture('amount-2000-01-01_2000-01-02.csv')
const expected = JSON.parse(fixture('expected.json')) as {
  currency: string
  timezone: string
  cost_rows: number
  amount_rows: number
  daily: { day: string; model: string; paid: string; granted: string; total: string; request_count: number }[]
  totals: { paid: string; granted: string; total: string; request_count: number }
}
const TZ = expected.timezone
const COST_HEADER = 'user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency'
const costRow = (cells: Partial<Record<'start' | 'end' | 'model' | 'wallet' | 'cost' | 'currency', string>> = {}) =>
  ['DEMO_USER_NOT_REAL', cells.start ?? '2000-01-01T00:00:00+08:00', cells.end ?? '2000-01-02T00:00:00+08:00',
    cells.model ?? 'deepseek-flash', cells.wallet ?? 'Paid', cells.cost ?? '0.1', cells.currency ?? 'CNY'].join(',')

describe('DeepSeek cost table', () => {
  it('is picked automatically by its header, BOM included', () => {
    expect(COST.charCodeAt(0)).toBe(0xfeff)
    expect(pickBillParser(COST).id).toBe('deepseek')
  })

  it('reads every cost line with its day in the reconcile time zone, model, wallet and exact amount', () => {
    const r = deepseekCost.parse(COST, { tz: TZ })
    expect(r.skipped).toEqual([])
    expect(r.rows).toHaveLength(expected.cost_rows)
    expect(r.rows.map(x => [x.day, x.model, x.wallet, x.amount, x.currency, x.line])).toEqual([
      ['2000-01-01', 'deepseek-flash', 'Paid', '0.5', 'CNY', 2],
      ['2000-01-01', 'deepseek-flash', 'Granted', '0.34', 'CNY', 3],
      ['2000-01-02', 'deepseek-flash', 'Paid', '0.037', 'CNY', 4],
    ])
  })

  it('summarizes paid, granted and total per day and overall exactly as expected.json, with request counts from the usage table', () => {
    const cost = deepseekCost.parse(COST, { tz: TZ }).rows
    const usage = parseDeepSeekUsage(USAGE, { tz: TZ })
    expect(usage.skipped).toEqual([])
    expect(usage.lines).toBe(expected.amount_rows)
    const s = summarizeDeepSeek(cost, usage.days)
    expect(s.daily.map(d => ({ day: d.day, model: d.model, paid: d.paid, granted: d.granted, total: d.total, request_count: d.requestCount })))
      .toEqual(expected.daily)
    expect(s.totals).toHaveLength(1)
    const [t] = s.totals
    expect(t!.currency).toBe(expected.currency)
    expect({ paid: t!.paid, granted: t!.granted, total: t!.total, request_count: t!.requestCount }).toEqual(expected.totals)
  })

  it('keeps Paid and Granted apart in the summary but adds them up for the comparison', () => {
    const s = summarizeDeepSeek(deepseekCost.parse(COST, { tz: TZ }).rows)
    expect(s.daily[0]).toMatchObject({ paid: '0.5', granted: '0.34', total: '0.84', requestCount: null })
  })

  it('reports bad lines with their line number and reason, never dropping them silently', () => {
    const text = [COST_HEADER,
      costRow({ cost: 'abc' }),
      costRow({ currency: 'EUR' }),
      costRow({ model: '' }),
      costRow({ wallet: '' }),
      costRow({ start: '2000-02-30T00:00:00+08:00' }),
      costRow({ start: '2000-01-01T00:00:00' }),
      costRow(),
    ].join('\n')
    const r = deepseekCost.parse(text, { tz: TZ })
    expect(r.rows.map(x => x.line)).toEqual([8])
    expect(r.skipped.map(s => s.line)).toEqual([2, 3, 4, 5, 6, 7])
    expect(r.skipped[0]!.reason).toContain('金额')
    expect(r.skipped[1]!.reason).toContain('EUR')
    expect(r.skipped[2]!.reason).toContain('模型')
    expect(r.skipped[3]!.reason).toContain('钱包')
    expect(r.skipped[4]!.reason).toContain('2000-02-30')
    expect(r.skipped[5]!.reason).toContain('时区')
  })

  it('never echoes the account id or key columns in a reason', () => {
    const text = [COST_HEADER, costRow({ cost: '' }), costRow({ currency: '' })].join('\n')
    for (const s of deepseekCost.parse(text, { tz: TZ }).skipped) expect(s.reason).not.toContain('DEMO_USER_NOT_REAL')
    const usage = ['user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount',
      'DEMO_USER_NOT_REAL,2000-01-01T00:00:00+08:00,2000-01-02T00:00:00+08:00,deepseek-flash,"secret,name",SECRET_KEY,request_count,,x'].join('\n')
    const r = parseDeepSeekUsage(usage, { tz: TZ })
    expect(r.skipped).toHaveLength(1)
    expect(JSON.stringify(r.skipped)).not.toMatch(/DEMO_USER_NOT_REAL|SECRET_KEY|secret,name/)
  })

  it('maps model names only when asked, never merging aliases on its own', () => {
    const text = [COST_HEADER, costRow({ model: 'deepseek-chat' })].join('\n')
    expect(deepseekCost.parse(text, { tz: TZ }).rows[0]!.model).toBe('deepseek-chat')
    expect(deepseekCost.parse(text, { tz: TZ, modelMap: { 'deepseek-chat': 'deepseek-flash' } }).rows[0]!.model).toBe('deepseek-flash')
  })
})

describe('time zones', () => {
  it('gives the same day for the same instant written in UTC or +08:00', () => {
    expect(dayKeyOf('2000-01-01T00:00:00+08:00', 'Asia/Shanghai')).toBe('2000-01-01')
    expect(dayKeyOf('1999-12-31T16:00:00Z', 'Asia/Shanghai')).toBe('2000-01-01')
    expect(dayKeyOf('1999-12-31T16:00:00+00:00', 'Asia/Shanghai')).toBe('2000-01-01')
  })

  it('keys the day in the chosen zone, not the zone written in the bill', () => {
    expect(dayKeyOf('2000-01-01T00:00:00+08:00', 'UTC')).toBe('1999-12-31')
  })

  it('rejects impossible dates and times without an offset', () => {
    expect(dayKeyOf('2000-02-30T00:00:00+08:00', 'UTC')).toBeNull()
    expect(dayKeyOf('2000-01-01T25:00:00+08:00', 'UTC')).toBeNull()
    expect(dayKeyOf('2000-01-01T00:00:00', 'UTC')).toBeNull()
    expect(dayKeyOf('yesterday', 'UTC')).toBeNull()
  })
})

describe('DeepSeek usage table', () => {
  it('counts requests per day without charging for them, across keys and a key name with a comma', () => {
    const r = parseDeepSeekUsage(USAGE, { tz: TZ })
    expect(r.days.map(d => [d.day, d.model, d.requests])).toEqual([['2000-01-01', 'deepseek-flash', 14], ['2000-01-02', 'deepseek-flash', 2]])
    // price × amount of the token lines: a cross-check, never a second bill.
    expect(r.days.map(d => d.computedCost)).toEqual(['0.84', '0.037'])
  })

  it('is recognised and refused as a bill, with the reason', () => {
    expect(isDeepSeekUsageTable(USAGE)).toBe(true)
    expect(isDeepSeekUsageTable(COST)).toBe(false)
    expect(() => pickBillParser(USAGE)).toThrow(/用量表/)
    expect(() => genericCsv.parse(USAGE, { currency: 'CNY' })).toThrow(/用量表/)
  })
})

describe('official ZIP export', () => {
  it('reads stored and deflated entries', () => {
    const zip = makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: 'world '.repeat(50), deflate: true }])
    expect(readZip(zip).map(e => [e.name, e.data.toString('utf8')])).toEqual([['a.txt', 'hello'], ['b.txt', 'world '.repeat(50)]])
  })

  it('takes the cost table as the only source of amounts and the usage table for request counts', () => {
    const zip = makeZip([
      { name: 'amount-2000-01-01_2000-01-02.csv', data: USAGE, deflate: true },
      { name: 'cost-2000-01-01_2000-01-02.csv', data: COST, deflate: true },
    ])
    const loaded = loadDeepSeekExport(readZip(zip))
    expect(loaded.costName).toBe('cost-2000-01-01_2000-01-02.csv')
    expect(loaded.costText).toBe(COST)
    expect(loaded.usageText).toBe(USAGE)
    const s = summarizeDeepSeek(deepseekCost.parse(loaded.costText, { tz: TZ }).rows, parseDeepSeekUsage(loaded.usageText!, { tz: TZ }).days)
    expect(s.totals[0]!.total).toBe(expected.totals.total)
  })

  it('says when the cost table is missing, when there are several candidates, and when the file is not a ZIP', () => {
    expect(() => loadDeepSeekExport(readZip(makeZip([{ name: 'amount.csv', data: USAGE }])))).toThrow(/没有费用表/)
    expect(() => loadDeepSeekExport(readZip(makeZip([{ name: 'cost-a.csv', data: COST }, { name: 'cost-b.csv', data: COST }]))))
      .toThrow(/cost-a\.csv.*cost-b\.csv/)
    expect(() => readZip(Buffer.from('not a zip at all'))).toThrow(/ZIP/)
  })

  it('ignores files that are neither table', () => {
    const zip = makeZip([{ name: 'readme.txt', data: 'hi' }, { name: 'cost.csv', data: COST }])
    expect(loadDeepSeekExport(readZip(zip)).usageText).toBeUndefined()
  })
})
