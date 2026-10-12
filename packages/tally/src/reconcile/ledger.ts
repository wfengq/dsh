import { loadCatalog } from 'dsh-pricing-data'
import type { Currency, ProviderPriceOverride } from 'dsh-tally-api'
import { TallyPricing } from '../pricing-service.js'
import { dayKeyer, groupOf, toUsage } from '../query.js'
import { TallyStore, type UsageRow } from '../store.js'

/** One ledger line of a reconciliation: what the ledger says one model cost on one day. */
export interface LedgerDay {
  day: string
  model: string
  /** `null` when nothing on this line could be priced. */
  currency: Currency | null
  /** Decimal string; `'0'` when nothing was priced (the counts below say why). */
  amount: string
  requestCount: number
  unpricedCount: number
  unknownUsageCount: number
  /** Peak-band entries priced while that year's holiday calendar was missing (possibly overestimated). */
  holidayMissingCount: number
}

export interface LedgerDailyOptions {
  dbPath: string
  /** Inclusive `YYYY-MM-DD`, in `tz`. */
  from: string
  /** Inclusive `YYYY-MM-DD`, in `tz`. */
  to: string
  tz: string
  providerRoutes?: Record<string, string>
  overrides?: ProviderPriceOverride[]
}

/** The plugin's default route mapping (see `Config.providerRoutes` in ../index.ts). */
const DEFAULT_ROUTES = { 'deepseek-official': 'deepseek', 'deepseek-account': 'deepseek' }
const DAY_MS = 86_400_000

/** Per-day, per-model costs from the ledger, opened read-only. */
export function ledgerDaily(opts: LedgerDailyOptions): LedgerDay[] {
  const store = TallyStore.openReadOnly(opts.dbPath)
  try {
    const catalog = loadCatalog()
    const pricing = new TallyPricing(catalog, {
      providerRoutes: opts.providerRoutes ?? DEFAULT_ROUTES,
      overrides: opts.overrides ?? [],
    })
    const dayKey = dayKeyer(opts.tz)
    // Bills name the canonical model, so catalog aliases (e.g. deepseek-v4-flash → deepseek-flash) merge.
    const canonical = (route: string, model: string) =>
      catalog.providers[pricing.providerOf(route)]?.aliases?.[model] ?? model
    // A day in any zone lies within a day of the same UTC date, so widen by one day each side.
    const rows = store.usage({
      from: Date.parse(opts.from + 'T00:00:00Z') - DAY_MS,
      to: Date.parse(opts.to + 'T00:00:00Z') + 2 * DAY_MS,
    })
    const lines = new Map<string, { day: string; model: string; rows: UsageRow[] }>()
    for (const row of rows) {
      const day = dayKey(row.at)
      if (day < opts.from || day > opts.to) continue
      const model = canonical(row.route, row.model)
      const key = day + '\u0000' + model
      let line = lines.get(key)
      if (!line) lines.set(key, line = { day, model, rows: [] })
      line.rows.push(row)
    }
    const out: LedgerDay[] = []
    for (const { day, model, rows: entries } of [...lines.values()].sort((a, b) => (a.day + a.model < b.day + b.model ? -1 : 1))) {
      const group = groupOf(entries, pricing, day)
      const holidayMissingCount = entries.filter(e => e.usageKnown
        && pricing.quoteRoute(e.route, e.model, toUsage(e.tokens), e.at)?.holidayCalendarMissing === true).length
      const counts = {
        requestCount: group.requestCount,
        unpricedCount: group.unpricedCount,
        unknownUsageCount: group.unknownUsageCount,
        holidayMissingCount,
      }
      if (group.cost.length === 0) out.push({ day, model, currency: null, amount: '0', ...counts })
      // Counts describe the whole line, so they ride on its first currency only.
      group.cost.forEach((money, i) => out.push({
        day, model, currency: money.currency, amount: money.amount,
        ...(i === 0 ? counts : { requestCount: 0, unpricedCount: 0, unknownUsageCount: 0, holidayMissingCount: 0 }),
      }))
    }
    return out
  } finally {
    store.close()
  }
}
