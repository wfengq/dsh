import { addFixed, costOf, formatFixed, parseDecimal } from './decimal.js'
import type { Fixed } from './decimal.js'
import { nextBandChange, resolveBand } from './band.js'
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
  /** Price at this band's rates instead of the band that applies at `at`; no price when the version has no such band. */
  band?: Band
}

/** The band that applies to a (provider, model) at an instant, and when it next changes. */
export interface BandAt {
  band: Band
  /** Epoch milliseconds of the next band change; `null` for flat pricing or when none is within reach. */
  until: number | null
  /** The holiday calendar for the instant's year is missing; a `peak` band may be too high. */
  holidayCalendarMissing: boolean
}

const ZERO: Fixed = { units: 0n }

/** The version of `versions` in effect at `at` (half-open `[effectiveFrom, effectiveTo)`). */
export function effectiveVersion(versions: PriceVersion[] | undefined, at: number): PriceVersion | undefined {
  return versions?.find(v => Date.parse(v.effectiveFrom) <= at && (v.effectiveTo === undefined || at < Date.parse(v.effectiveTo)))
}

/** The version that can price (provider, model) at `at`, or `null` when none can. */
function priceableVersion(catalog: PriceCatalog, providerId: string, model: string, at: number) {
  const provider = Object.hasOwn(catalog.providers, providerId) ? catalog.providers[providerId] : undefined
  if (!provider) return null
  // "separate" has no defined semantics yet (reasoning tokens are part of outputTokens, so
  // billing them again would double-count); validateCatalog rejects it, and quote refuses it.
  if (provider.reasoningBilledAs === 'separate') return null
  const aliased = provider.aliases && Object.hasOwn(provider.aliases, model) ? provider.aliases[model] : model
  const versions = Object.hasOwn(provider.models, aliased) ? provider.models[aliased] : undefined
  const version = effectiveVersion(versions, at)
  if (!version) return null
  // Tiered multipliers are not implemented; refuse rather than under-price.
  if (version.tiers?.length) return null
  return { provider, version }
}

/**
 * The band that prices (provider, model) at `at` and when it next changes. Returns `null`
 * whenever `quote` could not price the model at `at` (no version, or no rates for the band).
 */
export function bandAt(catalog: PriceCatalog, q: { provider: string; model: string; at: number }): BandAt | null {
  const found = priceableVersion(catalog, q.provider, q.model, q.at)
  if (!found) return null
  const { version } = found
  const { band, holidayCalendarMissing } = resolveBand(version.windows, catalog.holidays, q.at)
  if (!version.rates[band]) return null
  return { band, until: nextBandChange(version.windows, catalog.holidays, q.at), holidayCalendarMissing }
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
  const found = priceableVersion(catalog, q.provider, q.model, q.at)
  if (!found) return null
  const { provider, version } = found

  const resolved = resolveBand(version.windows, catalog.holidays, q.at)
  const band = q.band ?? resolved.band
  // A forced band does not depend on the calendar, so only the resolved band carries the flag.
  const holidayCalendarMissing = q.band === undefined && resolved.holidayCalendarMissing
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
