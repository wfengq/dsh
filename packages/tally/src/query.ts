import type { TokenCounts } from 'dsh-pricing-data'
import type { Money, SessionUsage, TallyTokens, UsageGroup, UsageQuery } from 'dsh-tally-api'
import type { TallyPricing } from './pricing-service.js'
import type { UsageRow } from './store.js'

const FRACTION_DIGITS = 18
const SCALE = 10n ** BigInt(FRACTION_DIGITS)

/** Parse a Quote.amount (plain decimal, up to 18 fractional digits) into 18-dp fixed units. */
function amountUnits(amount: string): bigint {
  const dot = amount.indexOf('.')
  if (dot < 0) return BigInt(amount) * SCALE
  return BigInt(amount.slice(0, dot)) * SCALE + BigInt(amount.slice(dot + 1).padEnd(FRACTION_DIGITS, '0'))
}

function formatUnits(units: bigint): string {
  const whole = units / SCALE
  const fraction = (units % SCALE).toString().padStart(FRACTION_DIGITS, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : `${whole}`
}

const TOKENS_PER_MILLION = 1_000_000n
const RATE_BUCKET_MS = 15 * 60_000
const ZERO_USAGE: TokenCounts = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 }
const MAIN_PROBE: TokenCounts = { ...ZERO_USAGE, inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }
const CACHE_WRITE_PROBE: TokenCounts = { ...ZERO_USAGE, cacheWriteTokens: 1_000_000 }
const REASONING_PROBE: TokenCounts = { ...ZERO_USAGE, reasoningTokens: 1_000_000 }

const offsetFormatters = new Map<string, Intl.DateTimeFormat>()

/** UTC offset of `tz` at `at`, in whole milliseconds of local-minus-UTC (seconds resolution). */
export function utcOffsetMs(tz: string, at: number): number {
  let fmt = offsetFormatters.get(tz)
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
    offsetFormatters.set(tz, fmt)
  }
  const p: Record<string, number> = {}
  for (const part of fmt.formatToParts(at)) if (part.type !== 'literal') p[part.type] = Number(part.value)
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
  return local - Math.floor(at / 1000) * 1000
}

/**
 * True when `tz` has the same offset at both ends of the bucket and that offset is a whole
 * number of buckets, so local-time boundaries on a bucket multiple are bucket boundaries in UTC.
 */
function offsetStable(tz: string, bucket: number): boolean {
  const start = bucket * RATE_BUCKET_MS
  const a = utcOffsetMs(tz, start)
  return a % RATE_BUCKET_MS === 0 && a === utcOffsetMs(tz, start + RATE_BUCKET_MS - 1)
}

/** Per-million-token rates (18-dp units) that one request is billed at, plus the currency. */
interface RateCard {
  currency: Money['currency']
  input: bigint
  cacheRead: bigint
  /** `undefined`: no rate, so any tokens in that dimension make the entry unpriced. */
  cacheWrite: bigint | undefined
  output: bigint
  /** `undefined`: the reasoning probe quoted `null`, so reasoning tokens make the entry unpriced. */
  reasoning: bigint | undefined
}

/**
 * Memoises the rate card per (route, model, 15-minute bucket) so aggregating a large ledger does
 * not re-run band resolution and decimal parsing for every entry. A (route, model) is cached only
 * when `TallyPricing.bucketStableZones` proves every price-version and peak-window boundary is
 * aligned to the bucket size, and a bucket only when each involved time zone has a constant,
 * bucket-aligned UTC offset across it; everything else takes the exact `quoteRoute` path.
 * Under those conditions the price is constant within a bucket, so the cached path is identical
 * to `quoteRoute`. (The version/band/currency comparison of the two bucket ends below is a
 * belt-and-braces check.)
 * Rates are read from probe quotes of 1,000,000 tokens, whose breakdown equals the per-million
 * rate of each dimension (reasoning is `0`: it is part of the output count); a probe that quotes `null`
 * means that dimension has no rate. Cache write and reasoning are probed on their own because
 * their rates are often absent and would otherwise make the whole probe `null`.
 */
class RateCache {
  readonly #pricing: TallyPricing
  readonly #byRouteModel = new Map<string, { zones: string[] | null; buckets: Map<number, RateCard | null> }>()

  constructor(pricing: TallyPricing) {
    this.#pricing = pricing
  }

  /** Cost of one entry as 18-dp units, or null when no price is known. */
  price(e: UsageRow): { currency: Money['currency']; units: bigint } | null {
    const card = this.#card(e.route, e.model, e.at)
    if (card === null) return this.#direct(e)
    const t = e.tokens
    const reasoning = t.reasoning ?? 0
    if ((t.cacheWrite > 0 && card.cacheWrite === undefined) || (reasoning > 0 && card.reasoning === undefined)) return null
    // Same truncation as quote(): each dimension is floored on its own before summing.
    const units = BigInt(t.input) * card.input / TOKENS_PER_MILLION
      + BigInt(t.cacheRead) * card.cacheRead / TOKENS_PER_MILLION
      + BigInt(t.output) * card.output / TOKENS_PER_MILLION
      + (t.cacheWrite > 0 ? BigInt(t.cacheWrite) * card.cacheWrite! / TOKENS_PER_MILLION : 0n)
      + (reasoning > 0 ? BigInt(reasoning) * card.reasoning! / TOKENS_PER_MILLION : 0n)
    return { currency: card.currency, units }
  }

  #direct(e: UsageRow): { currency: Money['currency']; units: bigint } | null {
    const q = this.#pricing.quoteRoute(e.route, e.model, toUsage(e.tokens), e.at)
    return q === null ? null : { currency: q.currency, units: amountUnits(q.amount) }
  }

  #card(route: string, model: string, at: number): RateCard | null {
    const key = route + '\0' + model
    let slot = this.#byRouteModel.get(key)
    if (slot === undefined) {
      slot = { zones: this.#pricing.bucketStableZones(route, model, RATE_BUCKET_MS), buckets: new Map() }
      this.#byRouteModel.set(key, slot)
    }
    if (slot.zones === null) return null
    const bucket = Math.floor(at / RATE_BUCKET_MS)
    const hit = slot.buckets.get(bucket)
    if (hit !== undefined) return hit
    const card = slot.zones.every(tz => offsetStable(tz, bucket)) ? this.#probe(route, model, bucket) : null
    slot.buckets.set(bucket, card)
    return card
  }

  #probe(route: string, model: string, bucket: number): RateCard | null {
    const start = bucket * RATE_BUCKET_MS
    const a = this.#pricing.quoteRoute(route, model, MAIN_PROBE, start)
    if (a === null) return null
    const b = this.#pricing.quoteRoute(route, model, MAIN_PROBE, start + RATE_BUCKET_MS - 1)
    if (b === null || a.priceVersion !== b.priceVersion || a.band !== b.band || a.currency !== b.currency) return null
    const cacheWrite = this.#pricing.quoteRoute(route, model, CACHE_WRITE_PROBE, start)
    const reasoning = this.#pricing.quoteRoute(route, model, REASONING_PROBE, start)
    return {
      currency: a.currency,
      input: amountUnits(a.breakdown.input),
      cacheRead: amountUnits(a.breakdown.cacheRead),
      output: amountUnits(a.breakdown.output),
      cacheWrite: cacheWrite === null ? undefined : amountUnits(cacheWrite.breakdown.cacheWrite),
      reasoning: reasoning === null ? undefined : amountUnits(reasoning.breakdown.reasoning),
    }
  }
}

interface Accumulator {
  key: string
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number | undefined
  cost: Map<Money['currency'], bigint>
  requestCount: number
  unpricedCount: number
  unknownUsageCount: number
  /** Entries of sessions marked deleted. */
  deletedCount: number
}

function newAccumulator(key: string): Accumulator {
  return {
    key,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: undefined,
    cost: new Map(),
    requestCount: 0,
    unpricedCount: 0,
    unknownUsageCount: 0,
    deletedCount: 0,
  }
}

/** Ledger token buckets as the pricing `TokenCounts` shape. */
export function toUsage(t: TallyTokens): TokenCounts {
  return {
    inputTokens: t.input,
    cacheReadTokens: t.cacheRead,
    cacheWriteTokens: t.cacheWrite,
    outputTokens: t.output,
    reasoningTokens: t.reasoning,
  }
}

function add(acc: Accumulator, e: UsageRow, rates: RateCache): void {
  const t = e.tokens
  acc.requestCount++
  if (e.deleted === true) acc.deletedCount++
  acc.input += t.input
  acc.cacheRead += t.cacheRead
  acc.cacheWrite += t.cacheWrite
  acc.output += t.output
  if (t.reasoning !== undefined) acc.reasoning = (acc.reasoning ?? 0) + t.reasoning
  if (!e.usageKnown) {
    acc.unknownUsageCount++
    return
  }
  const priced = rates.price(e)
  if (priced === null) {
    acc.unpricedCount++
    return
  }
  acc.cost.set(priced.currency, (acc.cost.get(priced.currency) ?? 0n) + priced.units)
}

/** `withDeleted`: report `deletedCount` (only session groups do). */
function finish(acc: Accumulator, withDeleted = false): UsageGroup {
  const tokens: TallyTokens = { input: acc.input, cacheRead: acc.cacheRead, cacheWrite: acc.cacheWrite, output: acc.output }
  if (acc.reasoning !== undefined) tokens.reasoning = acc.reasoning
  const cost: Money[] = [...acc.cost]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, units]) => ({ amount: formatUnits(units), currency }))
  const group: UsageGroup = {
    key: acc.key,
    tokens,
    cost,
    requestCount: acc.requestCount,
    unpricedCount: acc.unpricedCount,
    unknownUsageCount: acc.unknownUsageCount,
  }
  if (withDeleted) group.deletedCount = acc.deletedCount
  return group
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function dayKeyer(tz: string): (at: number) => string {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  // Time zone offsets change on quarter-hour boundaries, so one lookup per 15 minutes is exact
  // and saves the (comparatively slow) Intl call for dense ledgers. Keyed by bucket, so entries
  // may come in any order.
  const BUCKET_MS = 15 * 60_000
  const keys = new Map<number, string>()
  return (at) => {
    const bucket = Math.floor(at / BUCKET_MS)
    let key = keys.get(bucket)
    if (key !== undefined) return key
    let year = ''
    let month = ''
    let day = ''
    for (const part of fmt.formatToParts(at)) {
      if (part.type === 'year') year = part.value
      else if (part.type === 'month') month = part.value
      else if (part.type === 'day') day = part.value
    }
    key = `${year}-${month}-${day}`
    keys.set(bucket, key)
    return key
  }
}

/**
 * Group entries and sum tokens and cost. Unknown-usage entries are counted but never priced;
 * entries without a known price are counted in `unpricedCount` and contribute no cost.
 * Entries may come in any order; groups are sorted by key ascending.
 */
export function aggregate(
  entries: UsageRow[],
  pricing: TallyPricing,
  groupBy: UsageQuery['groupBy'],
  tz: string,
): UsageGroup[] {
  let keyOf: (e: UsageRow) => string
  switch (groupBy) {
    case 'day': {
      const dayKey = dayKeyer(tz)
      keyOf = e => dayKey(e.at)
      break
    }
    case 'model': keyOf = e => e.model; break
    case 'provider': keyOf = e => pricing.providerOf(e.route); break
    case 'workspace': keyOf = e => e.workspaceId ?? ''; break
    case 'session': keyOf = e => e.sessionId; break
  }
  const rates = new RateCache(pricing)
  const groups = new Map<string, Accumulator>()
  for (const e of entries) {
    const key = keyOf(e)
    let acc = groups.get(key)
    if (acc === undefined) groups.set(key, acc = newAccumulator(key))
    add(acc, e, rates)
  }
  const withDeleted = groupBy === 'session'
  return [...groups.values()].sort((a, b) => compareKeys(a.key, b.key)).map(acc => finish(acc, withDeleted))
}

/** One group (keyed `key`) over all `entries`, priced like {@link aggregate}. */
export function groupOf(entries: UsageRow[], pricing: TallyPricing, key: string): UsageGroup {
  const rates = new RateCache(pricing)
  const acc = newAccumulator(key)
  for (const e of entries) add(acc, e, rates)
  return finish(acc)
}

/**
 * Usage of one session tree. `entries` are all entries whose `rootSessionId === sessionId`;
 * `total` covers all of them, `children` breaks down every other session (sub-agent) by id.
 */
export function sessionUsage(entries: UsageRow[], sessionId: string, pricing: TallyPricing): SessionUsage {
  const rates = new RateCache(pricing)
  const total = newAccumulator(sessionId)
  const children = new Map<string, Accumulator>()
  for (const e of entries) {
    add(total, e, rates)
    if (e.sessionId === sessionId) continue
    let acc = children.get(e.sessionId)
    if (acc === undefined) children.set(e.sessionId, acc = newAccumulator(e.sessionId))
    add(acc, e, rates)
  }
  return {
    sessionId,
    total: finish(total),
    children: [...children.values()]
      .sort((a, b) => compareKeys(a.key, b.key))
      .map(acc => ({ sessionId: acc.key, total: finish(acc) })),
  }
}
