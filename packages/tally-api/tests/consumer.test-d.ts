import { expectTypeOf, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { TokenCounts, Quote, PriceVersion } from 'dsh-pricing-data'
import type {
  BalanceFetcher,
  BalanceSnapshot,
  BudgetAlert,
  Money,
  PricingService,
  ProviderPriceOverride,
  SessionUsage,
  TallyEntry,
  TallyTokens,
  UsageGroup,
  UsageQuery,
  Wallet,
} from 'dsh-tally-api'

declare const ctx: Context

test('services are merged into Context', () => {
  expectTypeOf(ctx.tallyUsage.query).returns.resolves.toEqualTypeOf<UsageGroup[]>()
  expectTypeOf(ctx.tallyUsage.session).returns.resolves.toEqualTypeOf<SessionUsage>()
  expectTypeOf(ctx.tallyUsage.query).parameter(0).toEqualTypeOf<UsageQuery>()
  expectTypeOf(ctx.tallyBalance.get).returns.resolves.toEqualTypeOf<BalanceSnapshot | null>()
  expectTypeOf(ctx.tallyBalance.register).parameter(1).toEqualTypeOf<BalanceFetcher>()
  expectTypeOf(ctx.tallyBalance.register).returns.toEqualTypeOf<() => void>()
  expectTypeOf(ctx.tallyBudget.list).returns.items.toHaveProperty('limit')
  expectTypeOf(ctx.tallyPricing).toEqualTypeOf<PricingService>()
})

test('events are merged into Events', () => {
  ctx.on('tally/recorded', (e) => {
    expectTypeOf(e).toEqualTypeOf<TallyEntry>()
    expectTypeOf(e.cost).toEqualTypeOf<Money | null>()
    expectTypeOf(e.route).toEqualTypeOf<string>()
    expectTypeOf(e.provider).toEqualTypeOf<string>()
  })
  ctx.on('tally/balance-changed', (snap) => {
    expectTypeOf(snap).toEqualTypeOf<BalanceSnapshot>()
  })
  ctx.on('tally/budget-crossed', (alert) => {
    expectTypeOf(alert).toEqualTypeOf<BudgetAlert>()
    expectTypeOf(alert.threshold).toEqualTypeOf<0.8 | 1>()
  })
  // @ts-expect-error unknown event names are still rejected
  ctx.on('tally/nonexistent', () => {})
})

test('entry and token shapes', () => {
  expectTypeOf<TallyEntry['band']>().toEqualTypeOf<'peak' | 'offpeak' | 'flat' | null>()
  expectTypeOf<TallyEntry['tokens']>().toEqualTypeOf<TallyTokens>()
  expectTypeOf<TallyTokens>().toEqualTypeOf<{
    input: number
    cacheRead: number
    cacheWrite: number
    output: number
    reasoning?: number
  }>()
  expectTypeOf<UsageGroup['tokens']>().toEqualTypeOf<TallyTokens>()
  expectTypeOf<UsageGroup['cost']>().toEqualTypeOf<Money[]>()
  expectTypeOf<Money['currency']>().toEqualTypeOf<'CNY' | 'USD'>()
  expectTypeOf<Wallet['kind']>().toEqualTypeOf<'topup' | 'granted' | 'total'>()
})

test('UsageQuery shape', () => {
  expectTypeOf<UsageQuery['groupBy']>().toEqualTypeOf<'day' | 'model' | 'provider' | 'workspace' | 'session'>()
  expectTypeOf<UsageQuery['from']>().toEqualTypeOf<number>()
  expectTypeOf<UsageQuery['tz']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<NonNullable<UsageQuery['filter']>['band']>().toEqualTypeOf<'peak' | 'offpeak' | 'flat' | undefined>()
})

test('pricing quote reuses dsh-pricing-data types', () => {
  type QuoteArg = Parameters<PricingService['quote']>[0]
  expectTypeOf<QuoteArg['usage']>().toEqualTypeOf<TokenCounts>()
  expectTypeOf<QuoteArg['provider']>().toEqualTypeOf<string>()
  expectTypeOf<PricingService['quote']>().returns.toEqualTypeOf<Quote | null>()
  expectTypeOf<PricingService['catalogVersion']>().returns.toEqualTypeOf<string>()
  expectTypeOf<PricingService['overrides']>().returns.toEqualTypeOf<ProviderPriceOverride[]>()
  expectTypeOf<Extract<ProviderPriceOverride, { kind: 'manual' }>['currency']>().toEqualTypeOf<'CNY' | 'USD'>()
  expectTypeOf<PriceVersion>().not.toBeAny()
})
