import { describe, expect, it } from 'vitest'
import { nextBandChange, resolveBand } from '../src/band.js'
import type { HolidayCalendars, PeakWindows } from '../src/types.js'

const W: PeakWindows = { tz: 'Asia/Shanghai', peak: ['09:00-12:00', '14:00-18:00'], days: [1, 2, 3, 4, 5], excludeHolidays: 'CN' }
// 2026-10-01 is a test fixture only, not a real holiday arrangement.
const H: HolidayCalendars = { CN: { years: { '2026': { dates: ['2026-10-01'], source: { url: 'fixture', retrievedAt: '2026-10-10' } } } } }
const sh = (iso: string) => Date.parse(iso + '+08:00')

describe('resolveBand', () => {
  it('resolves peak on a weekday inside a window', () => {
    expect(resolveBand(W, H, sh('2026-10-14T09:00:00.000'))).toEqual({ band: 'peak', holidayCalendarMissing: false }) // Wednesday
  })

  it('treats window ends as exclusive and starts as inclusive', () => {
    expect(resolveBand(W, H, sh('2026-10-14T08:59:59.999')).band).toBe('offpeak')
    expect(resolveBand(W, H, sh('2026-10-14T11:59:59.999')).band).toBe('peak')
    expect(resolveBand(W, H, sh('2026-10-14T12:00:00.000')).band).toBe('offpeak')
    expect(resolveBand(W, H, sh('2026-10-14T14:00:00.000')).band).toBe('peak')
    expect(resolveBand(W, H, sh('2026-10-14T18:00:00.000')).band).toBe('offpeak')
  })

  it('is offpeak on weekends', () => {
    expect(resolveBand(W, H, sh('2026-10-17T10:00:00.000')).band).toBe('offpeak') // Saturday
  })

  it('is offpeak on calendar holidays', () => {
    expect(resolveBand(W, H, sh('2026-10-01T10:00:00.000'))).toEqual({ band: 'offpeak', holidayCalendarMissing: false })
  })

  it('flags a missing holiday calendar year on peak-eligible days only', () => {
    expect(resolveBand(W, H, sh('2027-03-03T10:00:00.000'))).toEqual({ band: 'peak', holidayCalendarMissing: true })
    expect(resolveBand(W, H, sh('2027-03-06T10:00:00.000'))).toEqual({ band: 'offpeak', holidayCalendarMissing: false }) // Saturday
  })

  it('does not flag a weekday off-peak result in a missing calendar year', () => {
    expect(resolveBand(W, H, sh('2027-03-03T12:30:00.000'))).toEqual({ band: 'offpeak', holidayCalendarMissing: false }) // Wednesday lunch
    expect(resolveBand(W, H, sh('2027-03-03T20:00:00.000'))).toEqual({ band: 'offpeak', holidayCalendarMissing: false })
  })

  it('flags a missing calendar id as well as a missing year', () => {
    expect(resolveBand(W, {}, sh('2026-10-14T10:00:00.000'))).toEqual({ band: 'peak', holidayCalendarMissing: true })
  })

  it('does not flag when excludeHolidays is not configured', () => {
    const { excludeHolidays: _omit, ...noHolidays } = W
    expect(resolveBand(noHolidays, {}, sh('2027-03-03T10:00:00.000'))).toEqual({ band: 'peak', holidayCalendarMissing: false })
  })

  it('returns flat without windows', () => {
    expect(resolveBand(undefined, H, sh('2026-10-14T10:00:00.000'))).toEqual({ band: 'flat', holidayCalendarMissing: false })
  })

  it('uses the window tz for the local date (UTC instant, next day in Shanghai)', () => {
    // 2026-10-13T16:30Z is 2026-10-14 00:30 in Shanghai: offpeak, not a date mismatch
    expect(resolveBand(W, H, Date.parse('2026-10-13T16:30:00.000Z')).band).toBe('offpeak')
    // 2026-10-14T01:00Z is 09:00 in Shanghai
    expect(resolveBand(W, H, Date.parse('2026-10-14T01:00:00.000Z')).band).toBe('peak')
  })

  it('ignores host TZ', () => {
    const original = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      expect(resolveBand(W, H, sh('2026-10-14T10:00:00.000')).band).toBe('peak')
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })
})

describe('nextBandChange', () => {
  it('returns the end of the current peak window', () => {
    // Wednesday 11:59:59 is peak; the window ends at 12:00 the same day.
    expect(nextBandChange(W, H, sh('2026-10-14T11:59:59.000'))).toBe(sh('2026-10-14T12:00:00.000'))
  })

  it('skips the weekend to the next Monday window start', () => {
    // Friday 18:30 is off-peak; the next peak starts on Monday 09:00.
    expect(nextBandChange(W, H, sh('2026-10-16T18:30:00.000'))).toBe(sh('2026-10-19T09:00:00.000'))
  })

  it('is strictly after the given instant', () => {
    expect(nextBandChange(W, H, sh('2026-10-14T12:00:00.000'))).toBe(sh('2026-10-14T14:00:00.000'))
    expect(nextBandChange(W, H, sh('2026-10-14T09:00:00.000'))).toBe(sh('2026-10-14T12:00:00.000'))
  })

  it('moves to the next day after the last window, or over a holiday', () => {
    expect(nextBandChange(W, H, sh('2026-10-14T18:00:00.000'))).toBe(sh('2026-10-15T09:00:00.000'))
    // 2026-10-01 (Thursday) is a fixture holiday: off-peak all day, so the next peak is Friday 09:00.
    expect(nextBandChange(W, H, sh('2026-09-30T18:00:00.000'))).toBe(sh('2026-10-02T09:00:00.000'))
  })

  it('returns null without windows', () => {
    expect(nextBandChange(undefined, H, sh('2026-10-14T10:00:00.000'))).toBeNull()
  })

  it('returns null when the band never changes within the lookahead', () => {
    expect(nextBandChange({ ...W, days: [] }, H, sh('2026-10-14T10:00:00.000'))).toBeNull()
  })
})
