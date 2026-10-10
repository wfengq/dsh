import { addFixed, costOf, formatFixed, parseDecimal } from './decimal.js'
import type { Fixed } from './decimal.js'
import { resolveBand } from './band.js'
import type { Band, PriceCatalog, PriceVersion, Rates, TokenCounts } from './types.js'

export interface Quote {
  /** Total as a decimal string. */
  amount: string
  currency: 'CNY' | 'USD'
  band: Band
  /** Amount per billed dimension; unbilled dimensions are '0'. */
  breakdown: { input: string; cacheRead: string; cacheWrite: string; output: string; reasoning: string }
  /** PriceVersion.id */
  priceVersion: string
  /** Set only when the holiday calendar for the request's year is missing; the quote may be too high. */
  holidayCalendarMissing?: true
}

export interface QuoteRequest {
  provider: string
  model: string
  usage: TokenCounts
  /** Request time in epoch milliseconds. */
  at: number
}

const ZERO: Fixed = { units: 0n }

function findVersion(versions: PriceVersion[] | undefined, at: number): PriceVersion | undefined {
  return versions?.find(v => Date.parse(v.effectiveFrom) <= at && (v.effectiveTo === undefined || at < Date.parse(v.effectiveTo)))
}

/** Cost of one dimension; undefined means tokens were used but no rate is known. */
function line(tokens: number | undefined, rate: string | undefined): Fixed | undefined {
  const n = tokens ?? 0
  if (n === 0) return ZERO
  if (rate === undefined) return undefined
  return costOf(n, parseDecimal(rate))
}

/**
 * Price a usage record. Returns null whenever a price cannot be determined
 * (unknown provider/model, no verified version at `at`, missing rate); never "0".
 */
export function quote(catalog: PriceCatalog, q: QuoteRequest): Quote | null {
  const provider = Object.hasOwn(catalog.providers, q.provider) ? catalog.providers[q.provider] : undefined
  if (!provider) return null
  // "separate" has no defined semantics yet (reasoning tokens are part of outputTokens, so
  // billing them again would double-count); validateCatalog rejects it, and quote refuses it.
  if (provider.reasoningBilledAs === 'separate') return null
  const aliased = provider.aliases && Object.hasOwn(provider.aliases, q.model) ? provider.aliases[q.model] : q.model
  const versions = Object.hasOwn(provider.models, aliased) ? provider.models[aliased] : undefined
  const version = findVersion(versions, q.at)
  if (!version) return null
  // Tiered multipliers are not implemented; refuse rather than under-price.
  if (version.tiers?.length) return null

  const { band, holidayCalendarMissing } = resolveBand(version.windows, catalog.holidays, q.at)
  const rates: Rates | undefined = version.rates[band]
  if (!rates) return null

  const { usage } = q
  const input = line(usage.inputTokens, rates.input)
  const cacheRead = line(usage.cacheReadTokens, rates.cacheRead)
  const cacheWrite = line(usage.cacheWriteTokens, rates.cacheWrite)
  const output = line(usage.outputTokens, rates.output)
  // Reasoning tokens are counted in outputTokens ("output") or not billed ("free").
  const reasoning = ZERO
  if (!input || !cacheRead || !cacheWrite || !output) return null

  const total = [input, cacheRead, cacheWrite, output, reasoning].reduce(addFixed, ZERO)
  const result: Quote = {
    amount: formatFixed(total),
    currency: provider.currency,
    band,
    breakdown: {
      input: formatFixed(input),
      cacheRead: formatFixed(cacheRead),
      cacheWrite: formatFixed(cacheWrite),
      output: formatFixed(output),
      reasoning: formatFixed(reasoning),
    },
    priceVersion: version.id,
  }
  if (holidayCalendarMissing) result.holidayCalendarMissing = true
  return result
}
