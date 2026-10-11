export type BudgetPeriod = 'day' | 'month'

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hourCycle: 'h23',
    })
    formatters.set(tz, f)
  }
  return f
}

interface LocalDate {
  year: number
  month: number
  day: number
}

function localDate(t: number, tz: string): LocalDate {
  const out: LocalDate = { year: 0, month: 0, day: 0 }
  for (const part of formatter(tz).formatToParts(t)) {
    if (part.type === 'year') out.year = Number(part.value)
    else if (part.type === 'month') out.month = Number(part.value)
    else if (part.type === 'day') out.day = Number(part.value)
  }
  return out
}

/** Comparable key; monotonic in the local calendar. */
function dateKey(d: LocalDate): number {
  return d.year * 10_000 + d.month * 100 + d.day
}

const MARGIN_MS = 26 * 3600_000

/**
 * Earliest instant whose local calendar date is >= the given date. This is local midnight, or the
 * first instant after a DST gap that swallows midnight.
 */
function firstInstantOf(date: LocalDate, tz: string): number {
  const target = dateKey(date)
  const utcMidnight = Date.UTC(date.year, date.month - 1, date.day)
  // UTC offsets span -12h..+14h, so local midnight is within 26h of the UTC midnight.
  let lo = utcMidnight - MARGIN_MS // local date < target
  let hi = utcMidnight + MARGIN_MS // local date >= target
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (dateKey(localDate(mid, tz)) >= target) hi = mid
    else lo = mid
  }
  return hi
}

/**
 * Bounds `[start, end)` (epoch ms) of the local calendar day or month containing `at` in zone `tz`.
 * Local midnights are located by searching, so DST days of 23 or 25 hours are handled.
 */
export function periodBounds(period: BudgetPeriod, at: number, tz: string): { start: number; end: number } {
  const local = localDate(at, tz)
  if (period === 'day') {
    // Date.UTC normalises day overflow (e.g. day 32 -> next month).
    const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1))
    return {
      start: firstInstantOf(local, tz),
      end: firstInstantOf(
        { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() },
        tz,
      ),
    }
  }
  const nextMonth = new Date(Date.UTC(local.year, local.month, 1))
  return {
    start: firstInstantOf({ year: local.year, month: local.month, day: 1 }, tz),
    end: firstInstantOf(
      { year: nextMonth.getUTCFullYear(), month: nextMonth.getUTCMonth() + 1, day: 1 },
      tz,
    ),
  }
}
