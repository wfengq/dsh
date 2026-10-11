import { describe, expect, it } from 'vitest'
import { parseCsv } from '../src/reconcile/csv-read.js'
import { billParsers, pickBillParser } from '../src/reconcile/bill.js'
import { genericCsv } from '../src/reconcile/generic-csv.js'

describe('parseCsv', () => {
  it('strips the BOM and handles CRLF, quoted commas and escaped quotes', () => {
    expect(parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n')).toEqual([['a', 'b'], ['x,1', 'he said "hi"']])
  })

  it('keeps newlines inside quoted fields and ignores a trailing blank line', () => {
    expect(parseCsv('a,b\n"line1\nline2",c\n\n')).toEqual([['a', 'b'], ['line1\nline2', 'c']])
  })
})

describe('generic CSV bill parser', () => {
  const header = '日期,模型,金额,币种\n'

  it('parses Chinese headers, slashed dates, currency symbols and thousands separators', () => {
    const r = genericCsv.parse(header + '2026/10/09,deepseek-flash,"¥1,234.50",CNY\n', {})
    expect(r.rows).toEqual([{ day: '2026-10-09', model: 'deepseek-flash', amount: '1234.5', currency: 'CNY', line: 2 }])
    expect(r.skipped).toEqual([])
  })

  it('accepts a date-time and English headers case-insensitively', () => {
    const r = genericCsv.parse('Date,MODEL,Cost,Currency\n2026-10-09 23:59:59,m,0.000001,USD\n', {})
    expect(r.rows[0]).toMatchObject({ day: '2026-10-09', amount: '0.000001', currency: 'USD' })
  })

  it('reports unparsable rows with their line number instead of dropping them', () => {
    const r = genericCsv.parse(header + '2026-10-09,a,1,CNY\n2026-10-09,b,abc,CNY\nnot-a-date,c,1,CNY\n', {})
    expect(r.rows.map(x => x.model)).toEqual(['a'])
    expect(r.skipped.map(s => s.line)).toEqual([3, 4])
    expect(r.skipped[0]!.reason).toMatch(/金额/)
    expect(r.skipped[1]!.reason).toMatch(/日期/)
  })

  it('uses the currency option when the bill has no currency column, and fails without either', () => {
    const csv = '日期,模型,金额\n2026-10-09,a,1\n'
    expect(genericCsv.parse(csv, { currency: 'CNY' }).rows[0]!.currency).toBe('CNY')
    expect(() => genericCsv.parse(csv, {})).toThrow(/币种/)
  })

  it('applies the model map and column overrides', () => {
    const r = genericCsv.parse('日期,模型,Total\n2026-10-09,deepseek-chat,2\n', {
      currency: 'CNY', columns: { amount: 'Total' }, modelMap: { 'deepseek-chat': 'deepseek-flash' },
    })
    expect(r.rows[0]).toMatchObject({ model: 'deepseek-flash', amount: '2' })
  })

  it('fails clearly when a required column is missing', () => {
    expect(() => genericCsv.parse('日期,金额\n2026-10-09,1\n', { currency: 'CNY' })).toThrow(/模型/)
  })
})

describe('bill parser registry', () => {
  it('registers the generic parser and picks it only when asked for explicitly', () => {
    expect(billParsers().map(p => p.id)).toContain('csv')
    expect(pickBillParser('日期,模型,金额\n', 'csv')).toBe(genericCsv)
    expect(() => pickBillParser('日期,模型,金额\n')).toThrow('无法识别账单格式，请用 --format 指定')
    expect(() => pickBillParser('x', 'nope')).toThrow(/nope/)
  })
})
