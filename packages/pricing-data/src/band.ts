import type { Band, HolidayCalendars, PeakWindows } from './types.js'

export interface BandResolution {
  band: Band
  holidayCalendarMissing: boolean
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    formatters.set(timeZone, f)
  }
  return f
}

function localParts(at: number, timeZone: string) {
  const parts: Record<string, string> = {}
  for (const p of formatterFor(timeZone).formatToParts(at)) parts[p.type] = p.value
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  // Intl may emit "24" for midnight in some engines even with h23; normalise.
  const hour = Number(parts.hour) % 24
  const minute = Number(parts.minute)
  // ISO weekday from the local calendar date (1 = Monday ... 7 = Sunday).
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return {
    year: String(year).padStart(4, '0'),
    date: `${String(year).padStart(4, '0')}-${parts.month}-${parts.day}`,
    isoWeekday: jsDay === 0 ? 7 : jsDay,
    minutes: hour * 60 + minute,
  }
}

function parseRange(range: string): [number, number] {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(range)
  if (!m) throw new RangeError(`Invalid peak range: ${range}`)
  return [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]
}

export function resolveBand(windows: PeakWindows | undefined, holidays: HolidayCalendars, at: number): BandResolution {
  if (!windows) return { band: 'flat', holidayCalendarMissing: false }

  const local = localParts(at, windows.tz)
  if (!windows.days.includes(local.isoWeekday)) return { band: 'offpeak', holidayCalendarMissing: false }

  let holidayCalendarMissing = false
  if (windows.excludeHolidays) {
    const year = holidays[windows.excludeHolidays]?.years[local.year]
    if (!year) holidayCalendarMissing = true
    else if (year.dates.includes(local.date)) return { band: 'offpeak', holidayCalendarMissing: false }
  }

  const inPeak = windows.peak.some(range => {
    const [start, end] = parseRange(range)
    return local.minutes >= start && local.minutes < end
  })
  // A missing calendar can only turn a peak into off-peak, so it only matters (price may be overestimated) for peak results.
  return inPeak ? { band: 'peak', holidayCalendarMissing } : { band: 'offpeak', holidayCalendarMissing: false }
}

const DAY_MS = 86_400_000
const LOOKAHEAD_DAYS = 8
const offsetFormatters = new Map<string, Intl.DateTimeFormat>()

/** UTC offset of `timeZone` at `at`, as local-minus-UTC in milliseconds (second resolution). */
function utcOffsetMs(timeZone: string, at: number): number {
  let fmt = offsetFormatters.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
    offsetFormatters.set(timeZone, fmt)
  }
  const p: Record<string, number> = {}
  for (const part of fmt.formatToParts(at)) if (part.type !== 'literal') p[part.type] = Number(part.value)
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!) - Math.floor(at / 1000) * 1000
}

/** The instant at which the wall clock of `timeZone` reads `localMs` (a local time expressed as if it were UTC). */
function localToUtc(timeZone: string, localMs: number): number {
  // The offset is looked up at the guess and once more at the corrected instant, which settles
  // everywhere except inside a daylight-saving gap (where the wall time does not exist).
  let utc = localMs - utcOffsetMs(timeZone, localMs)
  utc = localMs - utcOffsetMs(timeZone, utc)
  return utc
}

/**
 * The earliest instant strictly after `at` whose band differs from the band at `at`, or `null`
 * when there are no `windows` (flat pricing) or the band does not change within eight days.
 *
 * Candidates are the start and end of every peak range and local midnight (weekday and holiday
 * rules switch there) on each of the following days; only these instants can change the band.
 */
export function nextBandChange(windows: PeakWindows | undefined, holidays: HolidayCalendars, at: number): number | null {
  if (!windows) return null
  const current = resolveBand(windows, holidays, at).band
  const minutes = new Set<number>([0])
  for (const range of windows.peak) for (const m of parseRange(range)) minutes.add(m)

  const local = localParts(at, windows.tz)
  const [year, month, day] = local.date.split('-').map(Number) as [number, number, number]
  const candidates: number[] = []
  for (let d = 0; d <= LOOKAHEAD_DAYS; d++) {
    const midnight = Date.UTC(year, month - 1, day + d)
    for (const m of minutes) {
      // A range end of 24:00 is the next day's midnight, which the next day already covers.
      if (m >= 24 * 60) continue
      const t = localToUtc(windows.tz, midnight + m * 60_000)
      if (t > at && t <= at + LOOKAHEAD_DAYS * DAY_MS) candidates.push(t)
    }
  }
  candidates.sort((a, b) => a - b)
  for (const t of candidates) {
    if (resolveBand(windows, holidays, t).band !== current) return t
  }
  return null
}
