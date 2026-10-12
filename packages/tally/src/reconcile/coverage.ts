/** Where the price data starts: bill days before it cannot be compared, the ledger has no price for them. */
import type { PriceCatalog } from 'dsh-pricing-data'
import { dayKeyOf } from './deepseek.js'

/** Day (in `tz`) each model's first price version takes effect, keyed by model name and every alias. */
export function pricesFromByModel(catalog: PriceCatalog, tz: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const provider of Object.values(catalog.providers)) {
    for (const [model, versions] of Object.entries(provider.models)) {
      const first = versions[0]?.effectiveFrom
      const day = first === undefined ? null : dayKeyOf(first, tz)
      if (day !== null && (out[model] === undefined || day < out[model]!)) out[model] = day
    }
    for (const [alias, model] of Object.entries(provider.aliases ?? {})) {
      if (out[model] !== undefined && out[alias] === undefined) out[alias] = out[model]!
    }
  }
  return out
}
