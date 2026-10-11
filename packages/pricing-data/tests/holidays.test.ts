import { describe, expect, it } from 'vitest'
import { loadCatalog, quote, resolveBand, validateCatalog } from '../src/index.js'

const sh = (iso: string) => Date.parse(iso + '+08:00')
const c = loadCatalog()
const windows = c.providers.deepseek!.models['deepseek-flash']![0]!.windows
const M = 1_000_000
const u = { inputTokens: M, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }

describe('CN holidays 2026', () => {
  it('validates and lists the 33 days off in order', () => {
    expect(validateCatalog(c)).toEqual([])
    const dates = c.holidays.CN!.years['2026']!.dates
    expect(dates).toHaveLength(33)
    expect(dates.every(d => /^2026-\d{2}-\d{2}$/.test(d))).toBe(true)
    expect([...dates].sort()).toEqual(dates)
    expect(new Set(dates).size).toBe(33)
  })

  it.each([
    ['2026-10-05T10:00:00', 'offpeak'], // Monday, National Day
    ['2026-10-09T10:00:00', 'peak'], // ordinary Friday
    ['2026-10-10T10:00:00', 'offpeak'], // Saturday make-up workday stays off-peak
    ['2026-02-23T15:00:00', 'offpeak'], // last day of Spring Festival
    ['2026-02-24T09:00:00', 'peak'], // first working day after it
  ])('resolves %s as %s with the calendar present', (iso, band) => {
    const r = resolveBand(windows, c.holidays, sh(iso))
    expect(r.band).toBe(band)
    expect(r.holidayCalendarMissing ?? false).toBe(false)
  })

  it('still flags a missing calendar for 2027 weekday peaks', () => {
    const q = quote(c, { provider: 'deepseek', model: 'deepseek-flash', usage: u, at: sh('2027-03-02T10:00:00') })!
    expect(q.band).toBe('peak')
    expect(q.holidayCalendarMissing).toBe(true)
  })

  it('drops the missing-calendar flag from 2026 peak quotes', () => {
    const q = quote(c, { provider: 'deepseek', model: 'deepseek-flash', usage: u, at: sh('2026-10-14T10:00:00') })!
    expect(q.band).toBe('peak')
    expect('holidayCalendarMissing' in q).toBe(false)
  })
})
