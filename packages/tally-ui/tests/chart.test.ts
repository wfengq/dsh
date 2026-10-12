import { describe, expect, it } from 'vitest'
import { lineSegments, stackedBars } from '../src/client/dashboard/chart.ts'
import { addDecimal, compareDecimal } from '../src/client/dashboard/decimal.ts'

describe('stackedBars', () => {
  const days = [
    { key: '2026-10-10', peak: '1', offpeak: '3' },
    { key: '2026-10-11', peak: '2', offpeak: '0.5' },
  ]

  it('makes the largest day exactly as tall as the chart', () => {
    const bars = stackedBars(days, 200, 100)
    const columnHeight = (key: string) => bars.filter(b => b.key === key).reduce((sum, b) => sum + b.h, 0)
    expect(columnHeight('2026-10-10')).toBeCloseTo(100)
    expect(columnHeight('2026-10-11')).toBeCloseTo(62.5)
  })

  it('stacks the peak segment above the off-peak one', () => {
    const bars = stackedBars(days, 200, 100)
    const peak = bars.find(b => b.key === '2026-10-10' && b.band === 'peak')!
    const offpeak = bars.find(b => b.key === '2026-10-10' && b.band === 'offpeak')!
    expect(peak.y + peak.h).toBeCloseTo(offpeak.y)
    expect(offpeak.y + offpeak.h).toBeCloseTo(100)
    expect(peak.y).toBeCloseTo(0)
  })

  it('keeps columns inside the width and apart', () => {
    const bars = stackedBars(days, 200, 100)
    const [a, b] = [bars[0]!, bars[2]!]
    expect(a.x + a.w).toBeLessThan(b.x)
    expect(b.x + b.w).toBeLessThanOrEqual(200)
  })

  it('draws zero-height rectangles, never NaN, when every amount is zero', () => {
    const bars = stackedBars([{ key: 'a', peak: '0', offpeak: '0' }, { key: 'b', peak: '0', offpeak: '0.0' }], 100, 50)
    expect(bars).toHaveLength(4)
    for (const bar of bars) {
      expect(bar.h).toBe(0)
      for (const n of [bar.x, bar.y, bar.w, bar.h]) expect(Number.isNaN(n)).toBe(false)
    }
  })

  it('returns nothing for no days', () => {
    expect(stackedBars([], 100, 50)).toEqual([])
  })
})

describe('lineSegments', () => {
  it('breaks the line at missing values', () => {
    const segments = lineSegments([0.5, null, 1, 0], 100, 10)
    expect(segments).toHaveLength(2)
    expect(segments[0]).toEqual([{ x: 0, y: 5 }])
    expect(segments[1]?.[0]).toEqual({ x: 200 / 3, y: 0 })
    expect(segments[1]?.[1]).toEqual({ x: 100, y: 10 })
  })
})

describe('decimal helpers', () => {
  it('adds exactly', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3')
    expect(addDecimal('1.50', '0')).toBe('1.5')
    expect(addDecimal('0', '0')).toBe('0')
    expect(addDecimal('999999999999.0001', '0.0009')).toBe('999999999999.001')
  })
  it('compares exactly', () => {
    expect(compareDecimal('0.10', '0.1')).toBe(0)
    expect(compareDecimal('2', '10')).toBeLessThan(0)
    expect(compareDecimal('0.0001', '0')).toBeGreaterThan(0)
  })
})
