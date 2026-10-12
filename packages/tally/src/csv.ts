import type { TallyEntry } from 'dsh-tally-api'
import { utcOffsetMs } from './query.js'

export const CSV_HEADER = [
  'time', 'session', 'root_session', 'workspace', 'route', 'model', 'band',
  'input', 'cache_read', 'cache_write', 'output', 'cost', 'currency', 'price_version', 'usage_known',
] as const

/** ISO 8601 with milliseconds and the UTC offset of `timeZone` at that instant, e.g. `2026-10-14T10:00:03.000+08:00`. */
export function isoWithOffset(at: number, timeZone: string): string {
  const offset = utcOffsetMs(timeZone, at)
  const local = new Date(at + offset).toISOString().slice(0, 23)
  const minutes = Math.floor(Math.abs(offset) / 60_000)
  const sign = offset < 0 ? '-' : '+'
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  return `${local}${sign}${hh}:${mm}`
}

/** RFC 4180 quoting: only fields with a comma, quote or line break are quoted. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export function csvLine(fields: readonly string[]): string {
  return fields.map(csvField).join(',') + '\n'
}

/** One ledger row. A missing price leaves `band`, `cost`, `currency` and `price_version` empty, never `0`. */
export function csvRow(e: TallyEntry, timeZone: string): string {
  return csvLine([
    isoWithOffset(e.at, timeZone),
    e.sessionId,
    e.rootSessionId,
    e.workspaceId ?? '',
    e.route,
    e.model,
    e.band ?? '',
    String(e.tokens.input),
    String(e.tokens.cacheRead),
    String(e.tokens.cacheWrite),
    String(e.tokens.output),
    e.cost?.amount ?? '',
    e.cost?.currency ?? '',
    e.priceVersion ?? '',
    String(e.usageKnown),
  ])
}
