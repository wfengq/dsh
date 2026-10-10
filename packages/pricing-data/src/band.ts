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
  return { band: inPeak ? 'peak' : 'offpeak', holidayCalendarMissing }
}
