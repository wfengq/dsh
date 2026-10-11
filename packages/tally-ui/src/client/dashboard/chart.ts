/** Pure geometry of the dashboard charts. Floats appear only as pixel coordinates and ratios, never as money. */

export interface DayAmounts {
  key: string
  /** Decimal amount charged at the peak price. */
  peak: string
  /** Decimal amount charged at the off-peak or flat price. */
  offpeak: string
}

export interface Bar {
  x: number
  y: number
  w: number
  h: number
  band: 'peak' | 'offpeak'
  key: string
  /** The decimal amount the segment stands for, for its label; never used for geometry. */
  amount: string
}

/** A decimal string as a ratio operand; anything unparsable counts as zero. */
function magnitude(amount: string): number {
  const n = Number(amount)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Stacked bars, one column per day: the off-peak segment at the bottom, the peak segment above it.
 * Amounts are scaled against the largest day so the tallest column is exactly `height` high; when
 * every amount is zero all rectangles are zero-height at the baseline.
 */
export function stackedBars(days: readonly DayAmounts[], width: number, height: number): Bar[] {
  if (days.length === 0) return []
  const totals = days.map(d => magnitude(d.peak) + magnitude(d.offpeak))
  const max = Math.max(...totals)
  const slot = width / days.length
  const w = slot * 0.7
  const bars: Bar[] = []
  days.forEach((day, i) => {
    const x = i * slot + (slot - w) / 2
    const scale = max > 0 ? height / max : 0
    const offpeakH = magnitude(day.offpeak) * scale
    const peakH = magnitude(day.peak) * scale
    bars.push({ x, y: height - offpeakH, w, h: offpeakH, band: 'offpeak', key: day.key, amount: day.offpeak })
    bars.push({ x, y: height - offpeakH - peakH, w, h: peakH, band: 'peak', key: day.key, amount: day.peak })
  })
  return bars
}

/**
 * Polyline segments of a ratio series in `[0, 1]`; `null` values break the line. A single isolated
 * point yields a one-point segment so it can still be drawn as a dot.
 */
export function lineSegments(values: readonly (number | null)[], width: number, height: number): { x: number; y: number }[][] {
  const segments: { x: number; y: number }[][] = []
  let current: { x: number; y: number }[] = []
  const step = values.length > 1 ? width / (values.length - 1) : 0
  values.forEach((value, i) => {
    if (value === null || !Number.isFinite(value)) {
      if (current.length > 0) segments.push(current)
      current = []
      return
    }
    const clamped = Math.min(1, Math.max(0, value))
    current.push({ x: values.length > 1 ? i * step : width / 2, y: height - clamped * height })
  })
  if (current.length > 0) segments.push(current)
  return segments
}
