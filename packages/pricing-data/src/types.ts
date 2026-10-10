export type Band = 'peak' | 'offpeak' | 'flat'

export interface Rates {
  input: string
  cacheRead?: string
  cacheWrite?: string
  output: string
}

export interface PeakWindows {
  /** IANA time zone, e.g. 'Asia/Shanghai'. */
  tz: string
  /** Half-open local-time ranges, e.g. ['09:00-12:00', '14:00-18:00']. */
  peak: string[]
  /** ISO weekdays (1 = Monday) on which the peak rule applies. */
  days: number[]
  /** Holiday calendar id, e.g. 'CN': dates in the calendar are off-peak all day. */
  excludeHolidays?: string
}

export interface Source {
  url: string
  retrievedAt: string
  note?: string
}

export interface PriceVersion {
  /** Stable price version id, stored in the ledger. */
  id: string
  effectiveFrom: string
  effectiveTo?: string
  windows?: PeakWindows
  rates: { [band in Band]?: Rates }
  tiers?: { minInputTokens: number; multiplier: string }[]
  source: Source
}

export interface PriceCatalog {
  schemaVersion: 1
  generatedAt: string
  providers: Record<string, {
    currency: 'CNY' | 'USD'
    unit: 'per_million_tokens'
    reasoningBilledAs: 'output' | 'separate' | 'free'
    /** Sorted by effectiveFrom ascending. */
    models: Record<string, PriceVersion[]>
    aliases?: Record<string, string>
  }>
  holidays: Record<string, { years: Record<string, { dates: string[]; source: Source }> }>
}

export type HolidayCalendars = PriceCatalog['holidays']

/** Structurally compatible with the official TokenUsage, so this package does not depend on dsh. */
export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
