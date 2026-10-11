import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
import {
  addFixed,
  bandAt,
  costOf,
  effectiveVersion,
  formatFixed,
  loadCatalog,
  parseDecimal,
  quote,
  type Band,
  type Fixed,
  type PriceCatalog,
  type Quote,
  type Rates,
  type TokenCounts,
} from 'dsh-pricing-data'
import type { BandView, CatalogView, PricingService, ProviderPriceOverride, TallyStatus } from 'dsh-tally-api'

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

/** An alias that points outside the catalog could never price anything, so it is refused up front. */
function checkAliasTarget(catalog: PriceCatalog, o: Extract<ProviderPriceOverride, { kind: 'alias' }>): void {
  const { provider: vendor, model } = o.target
  const provider = Object.hasOwn(catalog.providers, vendor) ? catalog.providers[vendor] : undefined
  if (!provider) {
    throw new RangeError(`Alias price override ${o.provider}: target provider "${vendor}" is not in the price catalog`)
  }
  if (model !== undefined && !Object.hasOwn(provider.models, model) && !(provider.aliases && Object.hasOwn(provider.aliases, model))) {
    throw new RangeError(`Alias price override ${o.provider}: target model "${model}" is not a model of "${vendor}" in the price catalog`)
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
      if (o.kind === 'alias') checkAliasTarget(catalog, o)
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

  /**
   * Price one request of a route. `band` prices it at that band's rates instead of the band
   * that applies at `at`; a manual override has only flat rates, so any other band is unpriced.
   */
  quoteRoute(route: string, model: string, usage: TokenCounts, at: number, band?: Band): Quote | null {
    const override = this.#byRoute.get(route)
    if (override?.kind === 'manual') {
      if (band !== undefined && band !== 'flat') return null
      return quoteManual(route, this.#manual.get(route)!, model, usage)
    }
    const { provider, model: target } = this.#target(route, model)
    return quote(this.#catalog, { provider, model: target, usage, at, ...band === undefined ? {} : { band } })
  }

  /** The catalog vendor and model that (route, model) is priced as, after route mapping and alias overrides. */
  #target(route: string, model: string): { provider: string; model: string } {
    const override = this.#byRoute.get(route)
    if (override?.kind === 'alias') return { provider: override.target.provider, model: override.target.model ?? model }
    return { provider: this.providerOf(route), model }
  }

  /**
   * The price band of (route, model) at `at` and when it next changes, or `null` when no price
   * is known. A manual override has no peak windows: its band is always flat.
   */
  bandOf(route: string, model: string, at: number): BandView | null {
    const override = this.#byRoute.get(route)
    if (override?.kind === 'manual') {
      return this.#manual.get(route)!.models.has(model) ? { band: 'flat', until: null, holidayCalendarMissing: false } : null
    }
    return bandAt(this.#catalog, { ...this.#target(route, model), at })
  }

  /** The bundled catalog with, for each model, the price version in effect at `at`, and the overrides in effect. */
  catalogView(at: number): CatalogView {
    const providers: CatalogView['providers'] = []
    for (const [id, provider] of Object.entries(this.#catalog.providers)) {
      const models: CatalogView['providers'][number]['models'] = []
      for (const [model, versions] of Object.entries(provider.models)) {
        const version = effectiveVersion(versions, at)
        if (!version) continue
        models.push({
          model,
          priceVersion: version.id,
          effectiveFrom: version.effectiveFrom,
          source: { url: version.source.url, retrievedAt: version.source.retrievedAt },
        })
      }
      providers.push({ id, currency: provider.currency, models })
    }
    return { version: this.#catalog.generatedAt, overrides: structuredClone(this.#overrides), providers }
  }

  /**
   * Whether prices for (route, model) are guaranteed constant inside every `bucketMs`-aligned
   * epoch bucket, apart from time zone offset changes. Returns the IANA time zones whose offset
   * the caller must still check per bucket, or `null` when it cannot be guaranteed (the caller
   * must then use `quoteRoute` for every entry).
   *
   * Guaranteed when every price version that can apply has `effectiveFrom`/`effectiveTo` on a
   * bucket boundary and every peak-window boundary falls on a bucket boundary of local time
   * (`bucketMs` must be a whole number of minutes). With a UTC offset that is a bucket multiple
   * and constant across the bucket, local-time boundaries are then also bucket boundaries, and
   * weekdays and holiday dates (which change at local midnight) cannot change inside a bucket.
   */
  bucketStableZones(route: string, model: string, bucketMs: number): string[] | null {
    if (this.#byRoute.get(route)?.kind === 'manual') return []
    const target = this.#target(route, model)
    const provider = Object.hasOwn(this.#catalog.providers, target.provider) ? this.#catalog.providers[target.provider] : undefined
    if (!provider) return []
    const aliased = provider.aliases && Object.hasOwn(provider.aliases, target.model) ? provider.aliases[target.model] : target.model
    const versions = Object.hasOwn(provider.models, aliased) ? provider.models[aliased] : undefined
    const bucketMinutes = bucketMs / 60_000
    const zones = new Set<string>()
    for (const v of versions ?? []) {
      for (const iso of [v.effectiveFrom, v.effectiveTo]) {
        if (iso === undefined) continue
        const t = Date.parse(iso)
        if (!Number.isFinite(t) || t % bucketMs !== 0) return null
      }
      if (!v.windows) continue
      zones.add(v.windows.tz)
      for (const range of v.windows.peak) {
        const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(range)
        if (!m) return null
        if ((Number(m[1]) * 60 + Number(m[2])) % bucketMinutes !== 0 || (Number(m[3]) * 60 + Number(m[4])) % bucketMinutes !== 0) return null
      }
    }
    return [...zones]
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

/** Price overrides as the service reads them: a fixed list, or the plugin's volatile config field. */
export type OverridesSource = readonly ProviderPriceOverride[] | Volatile<readonly ProviderPriceOverride[] | undefined>

export interface TallyPricingServiceConfig {
  providerRoutes: Record<string, string>
  overrides: OverridesSource
  /**
   * Subscribes to changes of `overrides`; returns the unsubscribe function. The plugin's `apply`
   * forwards `loader/volatile-update` here, because the Loader dispatches that event to the
   * entry's own fiber only, not to this service's.
   */
  watch?: (listener: () => void) => () => void
}

/** Mutable state, kept in one plain object because service methods may run on a cordis proxy. */
interface PricingState {
  pricing: TallyPricing
  errors: TallyStatus['errors']
  observers: Set<() => void>
}

function isVolatileSource(source: OverridesSource): source is Volatile<readonly ProviderPriceOverride[] | undefined> {
  return !Array.isArray(source) && typeof (source as { get?: unknown }).get === 'function'
}

/** The current overrides as fresh mutable copies (volatile snapshots are frozen). */
function readOverrides(source: OverridesSource): ProviderPriceOverride[] {
  const list = isVolatileSource(source) ? source.get() ?? [] : source
  return list.map(o => structuredClone(o) as ProviderPriceOverride)
}

/**
 * `ctx.tallyPricing`: the bundled catalog with the user's route mapping and overrides.
 *
 * An override that cannot be used (a malformed manual rate, or an alias whose target provider
 * or model is not in the catalog) is skipped with a warning instead of failing the service; it
 * is listed in {@link configErrors}, which `ctx.tallyUsage.status()` reports.
 *
 * The overrides are a volatile config field: when the settings page edits them, {@link reload}
 * rebuilds the pricing in place, without remounting the plugin. Amounts are always computed at
 * query time, so nothing stored has to be rebuilt.
 *
 * Service methods may run with `this` bound to a cordis context proxy, so this class keeps
 * no `#private` state.
 */
export class TallyPricingService extends Service implements PricingService {
  private readonly options: TallyPricingServiceConfig
  private readonly catalog: PriceCatalog
  private readonly state: PricingState

  constructor(ctx: Context, config: TallyPricingServiceConfig) {
    super(ctx, 'tallyPricing')
    this.options = config
    this.catalog = loadCatalog()
    this.state = { ...this.build(), observers: new Set() }
    const watch = config.watch
    if (watch) ctx.effect(() => watch(() => this.reload()), 'tallyPricing overrides')
    const observers = this.state.observers
    ctx.effect(() => () => { observers.clear() }, 'tallyPricing observers')
  }

  /** The pricing engine that `ctx.tallyUsage` aggregates with; replaced when the overrides change. */
  get pricing(): TallyPricing {
    return this.state.pricing
  }

  /** Overrides that were skipped because they could not be used. */
  get configErrors(): TallyStatus['errors'] {
    return this.state.errors
  }

  /**
   * Rebuild the pricing from the current overrides and notify change observers. Rate caches
   * live only for one aggregation, so the next query prices with the new rules.
   */
  reload(): void {
    Object.assign(this.state, this.build())
    for (const observer of [...this.state.observers]) {
      try {
        observer()
      } catch (error) {
        this.ctx.logger.warn(`pricing change observer failed: ${(error as Error).message}`)
      }
    }
  }

  /**
   * Calls `observer` after every rebuild of the pricing; returns the unsubscribe function.
   * Internal (used by the Remote `watch` stream): not part of `PricingService`.
   */
  watchChanges(observer: () => void): () => void {
    const observers = this.state.observers
    observers.add(observer)
    return () => { observers.delete(observer) }
  }

  private build(): Pick<PricingState, 'pricing' | 'errors'> {
    const usable: ProviderPriceOverride[] = []
    const errors: TallyStatus['errors'] = []
    for (const override of readOverrides(this.options.overrides)) {
      try {
        // Parsing one override on its own surfaces exactly the errors it would raise.
        new TallyPricing(this.catalog, { providerRoutes: {}, overrides: [override] })
        usable.push(override)
      } catch (error) {
        const message = `Ignored price override for provider "${override.provider}": ${(error as Error).message}`
        errors.push({ message })
        this.ctx.logger.warn(message)
      }
    }
    return { pricing: new TallyPricing(this.catalog, { providerRoutes: this.options.providerRoutes, overrides: usable }), errors }
  }

  quote(q: { provider: string; model: string; usage: TokenCounts; at: number }): Quote | null {
    return this.pricing.quote(q)
  }

  catalogVersion(): string {
    return this.pricing.catalogVersion()
  }

  /** The overrides in effect (invalid ones excluded). */
  overrides(): ProviderPriceOverride[] {
    return this.pricing.overrides()
  }
}
