import {
  addFixed,
  costOf,
  formatFixed,
  parseDecimal,
  quote,
  type Fixed,
  type PriceCatalog,
  type Quote,
  type Rates,
  type TokenCounts,
} from 'dsh-pricing-data'
import type { PricingService, ProviderPriceOverride } from 'dsh-tally-api'

export interface TallyPricingOptions {
  /** Route id (as recorded in the session log) -> pricing vendor in the catalog. */
  providerRoutes: Record<string, string>
  overrides: ProviderPriceOverride[]
}

type ManualOverride = Extract<ProviderPriceOverride, { kind: 'manual' }>

interface ParsedRates {
  input: Fixed
  cacheRead?: Fixed
  cacheWrite?: Fixed
  output: Fixed
}

interface ParsedManual {
  currency: ManualOverride['currency']
  models: Map<string, ParsedRates>
}

const ZERO: Fixed = { units: 0n }

function parseRates(route: string, model: string, rates: Rates): ParsedRates {
  const parse = (dimension: string, value: string | undefined): Fixed | undefined => {
    if (value === undefined) return undefined
    try {
      return parseDecimal(value)
    } catch (error) {
      throw new RangeError(`Invalid ${dimension} rate for manual price override ${route}/${model}: ${(error as Error).message}`)
    }
  }
  return {
    input: parse('input', rates.input)!,
    cacheRead: parse('cacheRead', rates.cacheRead),
    cacheWrite: parse('cacheWrite', rates.cacheWrite),
    output: parse('output', rates.output)!,
  }
}

/** Cost of one dimension; undefined means tokens were used but no rate is known. */
function line(tokens: number | undefined, rate: Fixed | undefined): Fixed | undefined {
  const n = tokens ?? 0
  if (n === 0) return ZERO
  return rate === undefined ? undefined : costOf(n, rate)
}

function quoteManual(route: string, manual: ParsedManual, model: string, usage: TokenCounts): Quote | null {
  const rates = manual.models.get(model)
  if (!rates) return null
  const input = line(usage.inputTokens, rates.input)
  const cacheRead = line(usage.cacheReadTokens, rates.cacheRead)
  const cacheWrite = line(usage.cacheWriteTokens, rates.cacheWrite)
  const output = line(usage.outputTokens, rates.output)
  if (!input || !cacheRead || !cacheWrite || !output) return null
  // Manual prices have no separate reasoning rate: reasoning tokens are part of the output count.
  const total = [input, cacheRead, cacheWrite, output].reduce(addFixed, ZERO)
  return {
    amount: formatFixed(total),
    currency: manual.currency,
    band: 'flat',
    breakdown: {
      input: formatFixed(input),
      cacheRead: formatFixed(cacheRead),
      cacheWrite: formatFixed(cacheWrite),
      output: formatFixed(output),
      reasoning: '0',
    },
    priceVersion: 'manual:' + route,
  }
}

export class TallyPricing implements PricingService {
  readonly #catalog: PriceCatalog
  readonly #providerRoutes: Record<string, string>
  readonly #overrides: ProviderPriceOverride[]
  /** First override per route wins. */
  readonly #byRoute = new Map<string, ProviderPriceOverride>()
  readonly #manual = new Map<string, ParsedManual>()

  constructor(catalog: PriceCatalog, opts: TallyPricingOptions) {
    this.#catalog = catalog
    this.#providerRoutes = opts.providerRoutes
    this.#overrides = opts.overrides
    for (const o of opts.overrides) {
      if (this.#byRoute.has(o.provider)) continue
      this.#byRoute.set(o.provider, o)
      if (o.kind === 'manual') {
        const models = new Map<string, ParsedRates>()
        for (const [model, rates] of Object.entries(o.models)) models.set(model, parseRates(o.provider, model, rates))
        this.#manual.set(o.provider, { currency: o.currency, models })
      }
    }
  }

  /** The pricing vendor a route maps to (identity when unmapped). Overrides are not consulted. */
  providerOf(route: string): string {
    return Object.hasOwn(this.#providerRoutes, route) ? this.#providerRoutes[route] : route
  }

  quoteRoute(route: string, model: string, usage: TokenCounts, at: number): Quote | null {
    const override = this.#byRoute.get(route)
    if (override?.kind === 'manual') return quoteManual(route, this.#manual.get(route)!, model, usage)
    if (override?.kind === 'alias') {
      return quote(this.#catalog, {
        provider: override.target.provider,
        model: override.target.model ?? model,
        usage,
        at,
      })
    }
    return quote(this.#catalog, { provider: this.providerOf(route), model, usage, at })
  }

  quote(q: { provider: string; model: string; usage: TokenCounts; at: number }): Quote | null {
    return this.quoteRoute(q.provider, q.model, q.usage, q.at)
  }

  catalogVersion(): string {
    return this.#catalog.generatedAt
  }

  overrides(): ProviderPriceOverride[] {
    return this.#overrides
  }
}
