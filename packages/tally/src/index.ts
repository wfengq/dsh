import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import Schema from '@deepseek-ai/schemastery'
import type { ProviderPriceOverride } from 'dsh-tally-api'
import { TallyBalance } from './balance-service.js'
import { TallyBudget } from './budget-service.js'
import { TallyPricingService } from './pricing-service.js'
import { TallyUsage } from './usage-service.js'

export { TallyBalance, type TallyBalanceConfig } from './balance-service.js'
export { TallyBudget, type TallyBudgetConfig } from './budget-service.js'
export { Recorder, type SessionHeaderLike } from './recorder.js'
export { TallyPricing, TallyPricingService, type TallyPricingOptions } from './pricing-service.js'
export { TallyUsage, type TallyUsageConfig } from './usage-service.js'
export { TallyStore, type StoredEntry } from './store.js'

export const name = 'dsh-tally'

export interface Config {
  /** Route id recorded in session logs -> pricing vendor in the catalog. */
  providerRoutes: Record<string, string>
  overrides: ProviderPriceOverride[]
  /** Ledger file; defaults to `$DSH_HOME/tally/tally.v1.sqlite`. */
  dbPath?: string
  backfillBatch: number
  /** Quiet period after a recorded entry before its route's balance is refreshed. */
  balanceDebounceMs: number
  /** Minimum time between two automatic balance refreshes of one route. */
  balanceMinIntervalMs: number
  /** A balance request still pending after this long is aborted. */
  balanceTimeoutMs: number
  /** Budget file; defaults to `$DSH_HOME/tally/budgets.json`. */
  budgetPath?: string
  /** IANA time zone of budget periods; defaults to the host time zone. */
  timeZone?: string
}

const Rates = Schema.object({
  input: Schema.string().required(),
  cacheRead: Schema.string(),
  cacheWrite: Schema.string(),
  output: Schema.string().required(),
})

const Override = Schema.union([
  Schema.object({
    provider: Schema.string().required(),
    kind: Schema.const('alias').required(),
    target: Schema.object({
      provider: Schema.string().required(),
      model: Schema.string(),
    }).required(),
  }).description('按某个已知厂商（及可选的模型）的价格计费'),
  Schema.object({
    provider: Schema.string().required(),
    kind: Schema.const('manual').required(),
    currency: Schema.union(['CNY', 'USD'] as const).required(),
    models: Schema.dict(Rates).required(),
  }).description('手动填写每百万 token 的单价（十进制字符串）'),
])

export const Config: Schema<Config> = Schema.object({
  providerRoutes: Schema.dict(Schema.string())
    .default({ 'deepseek-official': 'deepseek', 'deepseek-account': 'deepseek' })
    .description('会话日志中的路由 id 到价格数据厂商的映射'),
  overrides: Schema.array(Override).default([]).description('厂商价格覆盖'),
  dbPath: Schema.string().description('账本数据库路径，默认 $DSH_HOME/tally/tally.v1.sqlite'),
  backfillBatch: Schema.natural().min(1).default(20).description('回填时每批读取的会话数'),
  balanceDebounceMs: Schema.natural().default(3000).description('记账后刷新余额前的去抖时间（毫秒）'),
  balanceMinIntervalMs: Schema.natural().default(60000).description('同一路由两次自动刷新余额之间的最小间隔（毫秒）'),
  balanceTimeoutMs: Schema.natural().min(1).default(10000).description('余额请求的超时时间（毫秒）'),
  budgetPath: Schema.string().description('预算文件路径，默认 $DSH_HOME/tally/budgets.json'),
  timeZone: Schema.string().description('预算按日、按月统计时使用的 IANA 时区，默认取宿主时区'),
})

export function apply(ctx: Context, config: Config) {
  ctx.plugin(TallyPricingService, { providerRoutes: config.providerRoutes, overrides: config.overrides })
  ctx.plugin(TallyBalance, {
    debounceMs: config.balanceDebounceMs,
    minIntervalMs: config.balanceMinIntervalMs,
    timeoutMs: config.balanceTimeoutMs,
  })
  ctx.plugin(TallyBudget, {
    path: config.budgetPath ?? dshHomePath('tally', 'budgets.json'),
    timeZone: config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
  ctx.plugin(TallyUsage, {
    // Resolved at startup rather than import time so a `DSH_HOME` set by the host applies.
    dbPath: config.dbPath ?? dshHomePath('tally', 'tally.v1.sqlite'),
    backfillBatch: config.backfillBatch,
  })
}
