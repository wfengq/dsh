// Type-only service definition for dsh-tally. Third-party plugins depend on this
// package alone; it has no runtime exports. See README.md for the semver promise.
// Required: makes the module augmentation below resolve @deepseek-ai/cordis.
import type {} from '@deepseek-ai/cordis'
import type { Quote, Rates, TokenCounts } from 'dsh-pricing-data'

export type { Quote, PriceVersion, Rates, TokenCounts } from 'dsh-pricing-data'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tallyPricing: PricingService
    tallyUsage: UsageService
    tallyBalance: BalanceService
    tallyBudget: BudgetService
  }

  interface Events {
    /** A usage record was written to the ledger (also fired for unpriced or unknown-usage records). */
    'tally/recorded'(entry: TallyEntry): void
    /** A provider's balance snapshot changed (fresh fetch, or marked stale after a failure). */
    'tally/balance-changed'(snap: BalanceSnapshot): void
    /** A budget reached 80% or 100% of its limit; fired once per threshold and period. */
    'tally/budget-crossed'(alert: BudgetAlert): void
  }
}

export type Currency = 'CNY' | 'USD'

export type TallyBand = 'peak' | 'offpeak' | 'flat'

/** A monetary amount. `amount` is a decimal string; floating point is never used for money. */
export interface Money {
  amount: string
  currency: Currency
}

export interface TallyTokens {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning?: number
}

export interface TallyEntry {
  id: string
  sessionId: string
  rootSessionId: string
  workspaceId?: string
  /** Epoch milliseconds. */
  at: number
  /** Raw provider (route) id as recorded in the session log. */
  route: string
  /**
   * Pricing vendor after the `providerRoutes` mapping; equals `route` when no mapping applies.
   * Price overrides are not reflected here: an alias override prices the entry as its target
   * vendor, but `provider` still names the route-mapped vendor.
   */
  provider: string
  model: string
  /** Price band of the quote; `null` when there is no quote (no price known, or unknown usage). */
  band: TallyBand | null
  tokens: TallyTokens
  /** `null` when no price is known or usage is unknown; never `"0"` as a stand-in. */
  cost: Money | null
  /** Price version of the quote; `null` when there is no quote (no price known, or unknown usage). */
  priceVersion: string | null
  usageKnown: boolean
}

export interface UsageQuery {
  /** Epoch milliseconds, inclusive. */
  from: number
  /** Epoch milliseconds, exclusive. */
  to: number
  groupBy: 'day' | 'model' | 'provider' | 'workspace' | 'session'
  filter?: {
    provider?: string
    model?: string
    workspaceId?: string
    rootSessionId?: string
    band?: TallyBand
  }
  /** IANA time zone used when grouping by day; defaults to the host time zone. */
  tz?: string
}

export interface UsageGroup {
  key: string
  tokens: TallyTokens
  /** One entry per currency; amounts are never converted between currencies. */
  cost: Money[]
  requestCount: number
  unpricedCount: number
  unknownUsageCount: number
}

export interface SessionUsage {
  sessionId: string
  total: UsageGroup
  children: { sessionId: string; total: UsageGroup }[]
}

export interface TallyStatus {
  backfill: { done: number; total: number } | null
  errors: { sessionId?: string; message: string }[]
}

export interface UsageService {
  query(q: UsageQuery): Promise<UsageGroup[]>
  /** Usage of one session, including a breakdown per sub-agent. */
  session(sessionId: string): Promise<SessionUsage>
  rebuild(): Promise<void>
  status(): TallyStatus
}

export type ProviderPriceOverride =
  | {
    provider: string
    kind: 'alias'
    /** Price this provider as the given known vendor (and optionally model). */
    target: { provider: string; model?: string }
  }
  | {
    provider: string
    kind: 'manual'
    currency: Currency
    /** Rates per million tokens, keyed by model id; a dimension without a rate cannot be used. */
    models: Record<string, Rates>
  }

export interface PricingService {
  /**
   * Price one request, with the user's overrides applied.
   * `provider` is a route id: `providerRoutes` and `overrides` are applied first,
   * then the catalog is consulted, so callers can pass the provider straight from the log.
   * Returns `null` when no price is known.
   */
  quote(q: { provider: string; model: string; usage: TokenCounts; at: number }): Quote | null
  catalogVersion(): string
  overrides(): ProviderPriceOverride[]
}

/** DeepSeek: granted balance is spent before top-up balance. */
export interface Wallet {
  kind: 'topup' | 'granted' | 'total'
  money: Money
}

export interface BalanceSnapshot {
  provider: string
  wallets: Wallet[]
  fetchedAt: number
  /** `true` when the last refresh failed and this is the previous successful snapshot. */
  stale: boolean
  error?: string
}

export type BalanceFetcher = (signal: AbortSignal) => Promise<Wallet[]>

export interface BalanceService {
  get(provider: string): Promise<BalanceSnapshot | null>
  refresh(provider: string): Promise<BalanceSnapshot | null>
  /** Register a fetcher for a provider; returns a dispose function. */
  register(provider: string, fetcher: BalanceFetcher): () => void
}

export interface Budget {
  id: string
  period: 'day' | 'month'
  scope: { workspaceId?: string }
  limit: Money
}

export interface BudgetAlert {
  budgetId: string
  threshold: 0.8 | 1
  spent: Money
  limit: Money
  periodStart: number
}

export interface BudgetService {
  list(): Budget[]
  set(b: Budget): void
  remove(id: string): void
}

export {}
