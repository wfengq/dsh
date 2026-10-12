import { describe, expect, it } from 'vitest'
import { periodBounds } from '../src/period.js'

const HOUR = 3600_000

describe('periodBounds', () => {
  it('returns the local calendar day', () => {
    expect(periodBounds('day', Date.parse('2026-10-14T10:00:00+08:00'), 'Asia/Shanghai')).toEqual({
      start: Date.parse('2026-10-14T00:00:00+08:00'),
      end: Date.parse('2026-10-15T00:00:00+08:00'),
    })
  })

  it('returns the local calendar month', () => {
    const at = Date.parse('2026-10-31T23:59:00+08:00')
    expect(periodBounds('month', at, 'Asia/Shanghai')).toEqual({
      start: Date.parse('2026-10-01T00:00:00+08:00'),
      end: Date.parse('2026-11-01T00:00:00+08:00'),
    })
  })

  it('rolls over the year for December', () => {
    const at = Date.parse('2026-12-15T12:00:00Z')
    expect(periodBounds('month', at, 'UTC')).toEqual({
      start: Date.parse('2026-12-01T00:00:00Z'),
      end: Date.parse('2027-01-01T00:00:00Z'),
    })
  })

  it('treats the boundary instant as the start of the next period', () => {
    const edge = Date.parse('2026-10-15T00:00:00+08:00')
    expect(periodBounds('day', edge, 'Asia/Shanghai').start).toBe(edge)
    expect(periodBounds('day', edge - 1, 'Asia/Shanghai').end).toBe(edge)
  })

  it('handles a 25-hour day when DST ends', () => {
    const at = Date.parse('2026-11-01T12:00:00-05:00')
    const { start, end } = periodBounds('day', at, 'America/New_York')
    expect(start).toBe(Date.parse('2026-11-01T00:00:00-04:00'))
    expect(end).toBe(Date.parse('2026-11-02T00:00:00-05:00'))
    expect(end - start).toBe(25 * HOUR)
  })

  it('handles a 23-hour day when DST starts', () => {
    const at = Date.parse('2026-03-08T12:00:00-04:00')
    const { start, end } = periodBounds('day', at, 'America/New_York')
    expect(end - start).toBe(23 * HOUR)
  })

  it('handles months that contain a DST change', () => {
    const { start, end } = periodBounds('month', Date.parse('2026-11-15T00:00:00Z'), 'America/New_York')
    expect(start).toBe(Date.parse('2026-11-01T00:00:00-04:00'))
    expect(end).toBe(Date.parse('2026-12-01T00:00:00-05:00'))
  })

  it('handles a zone whose DST starts at midnight', () => {
    // Asia/Beirut skips 00:00-01:00 on the last Sunday of March; local midnight does not exist.
    const { start, end } = periodBounds('day', Date.parse('2026-03-29T12:00:00+03:00'), 'Asia/Beirut')
    expect(end - start).toBe(23 * HOUR)
    expect(end).toBe(Date.parse('2026-03-30T00:00:00+03:00'))
  })
})
