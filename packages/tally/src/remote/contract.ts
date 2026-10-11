/**
 * Browser-facing contract of the `tally` Remote namespace (`dsh-tally/remote`).
 *
 * dsh's Typert generator only runs inside the dsh repository, so this package writes the
 * contribution by hand, in the shape of the generated `typert.remote-client.js` files: strict
 * zod codecs the Client Remote validates against, plus the declaration merges that type
 * `ctx.remote.tally`. The Host validates requests with the same `schemas`.
 *
 * This module must stay browser-safe: it may import only zod and types.
 */
import { z } from 'zod'
import type { RemoteResult, RemoteStreamHandle, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {
  BalanceSnapshot, BandView, Budget, BudgetAlert, CatalogView, PeakSavings, ProviderPriceOverride, SessionView, TallyEntry, TallyStatusView,
  TallyWatchFrame, TurnUsage, UsageGroup, UsageQuery,
} from 'dsh-tally-api'

const PACKAGE = 'dsh-tally'
const SERVICE = 'tallyRemote'
const NAMESPACE = 'tally'

/** Longest accepted range of a time-bounded request. */
const MAX_RANGE_MS = 400 * 86_400_000
/** Longest accepted string field. */
const MAX_TEXT = 256

const text = z.string().max(MAX_TEXT)

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

const timeZone = text.refine(isTimeZone, { message: 'unknown IANA time zone' })

/** Largest magnitude a JavaScript `Date` accepts, epoch milliseconds. */
const MAX_EPOCH_MS = 8.64e15

/** An epoch-millisecond timestamp: an integer a `Date` can hold. */
const epochMs = z.number().int().min(-MAX_EPOCH_MS).max(MAX_EPOCH_MS)

const range = { from: epochMs, to: epochMs }

/** Requires `from < to` and a span of at most 400 days; `from` and `to` are epoch milliseconds. */
function checkRange(r: { from: number; to: number }, ctx: z.RefinementCtx): void {
  if (!(r.from < r.to)) ctx.addIssue({ code: 'custom', message: 'from must be before to', path: ['from'] })
  else if (r.to - r.from > MAX_RANGE_MS) ctx.addIssue({ code: 'custom', message: 'the range must not exceed 400 days', path: ['to'] })
}

const band = z.enum(['peak', 'offpeak', 'flat'])
const currency = z.enum(['CNY', 'USD'])
const money = z.object({ amount: z.string(), currency })

const tokens = z.object({
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
  reasoning: z.number().optional(),
})

const usageGroup = z.object({
  key: z.string(),
  tokens,
  cost: z.array(money),
  requestCount: z.number(),
  unpricedCount: z.number(),
  unknownUsageCount: z.number(),
  deletedCount: z.number().optional(),
}) satisfies z.ZodType<UsageGroup>

const tallyEntry = z.object({
  id: z.string(),
  sessionId: z.string(),
  rootSessionId: z.string(),
  workspaceId: z.string().optional(),
  at: z.number(),
  route: z.string(),
  provider: z.string(),
  model: z.string(),
  band: band.nullable(),
  tokens,
  cost: money.nullable(),
  priceVersion: z.string().nullable(),
  usageKnown: z.boolean(),
}) satisfies z.ZodType<TallyEntry>

const tallyStatus = z.object({
  backfill: z.object({ done: z.number(), total: z.number() }).nullable(),
  errors: z.array(z.object({ sessionId: z.string().optional(), message: z.string() })),
})

const statusView = z.object({
  usage: tallyStatus,
  catalogVersion: z.string(),
  pricingErrors: z.array(z.string()),
  budgetErrors: z.array(z.string()),
  balanceRoutes: z.array(z.string()),
}) satisfies z.ZodType<TallyStatusView>

const budgetAlert = z.object({
  budgetId: z.string(),
  threshold: z.union([z.literal(0.8), z.literal(1)]),
  spent: money,
  limit: money,
  periodStart: z.number(),
}) satisfies z.ZodType<BudgetAlert>

const usageQuery = z.object({
  ...range,
  groupBy: z.enum(['day', 'model', 'provider', 'workspace', 'session']),
  filter: z.object({
    provider: text.optional(),
    model: text.optional(),
    workspaceId: text.optional(),
    rootSessionId: text.optional(),
    band: band.optional(),
  }).optional(),
  tz: timeZone.optional(),
}).superRefine(checkRange) satisfies z.ZodType<UsageQuery>

const sessionView = z.object({
  usage: z.object({
    sessionId: z.string(),
    total: usageGroup,
    children: z.array(z.object({ sessionId: z.string(), total: usageGroup })),
  }),
  lastRoute: z.string().nullable(),
  lastModel: z.string().nullable(),
}) satisfies z.ZodType<SessionView>

const turnUsage = z.object({
  total: usageGroup,
  attempts: z.array(tallyEntry),
}) satisfies z.ZodType<TurnUsage>

const bandView = z.object({
  band,
  until: z.number().nullable(),
  holidayCalendarMissing: z.boolean(),
}) satisfies z.ZodType<BandView>

const balanceSnapshot = z.object({
  provider: z.string(),
  wallets: z.array(z.object({ kind: z.enum(['topup', 'granted', 'total']), money })),
  fetchedAt: z.number(),
  stale: z.boolean(),
  error: z.string().optional(),
  errorCode: z.enum(['not-configured', 'signed-out', 'timeout', 'failed']).optional(),
}) satisfies z.ZodType<BalanceSnapshot>

/** Structure only: whether the id or the amount are acceptable is the budget service's call (`tally/invalid-budget`). */
const budget = z.object({
  id: text,
  period: z.enum(['day', 'month']),
  scope: z.object({ workspaceId: text.optional() }),
  limit: z.object({ amount: text, currency }),
}) satisfies z.ZodType<Budget>

const rates = z.object({
  input: z.string(),
  cacheRead: z.string().optional(),
  cacheWrite: z.string().optional(),
  output: z.string(),
})

const priceOverride = z.discriminatedUnion('kind', [
  z.object({
    provider: z.string(),
    kind: z.literal('alias'),
    target: z.object({ provider: z.string(), model: z.string().optional() }),
  }),
  z.object({
    provider: z.string(),
    kind: z.literal('manual'),
    currency,
    models: z.record(z.string(), rates),
  }),
]) satisfies z.ZodType<ProviderPriceOverride>

const catalogView = z.object({
  version: z.string(),
  overrides: z.array(priceOverride).optional(),
  providers: z.array(z.object({
    id: z.string(),
    currency,
    models: z.array(z.object({
      model: z.string(),
      priceVersion: z.string(),
      effectiveFrom: z.string(),
      source: z.object({ url: z.string(), retrievedAt: z.string() }),
    })),
  })),
}) satisfies z.ZodType<CatalogView>

const peakSavings = z.object({
  peak: z.array(money),
  offpeakEquivalent: z.array(money),
  saving: z.array(money),
}) satisfies z.ZodType<PeakSavings>

const watchFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), status: statusView }),
  z.object({ type: z.literal('recorded'), entry: tallyEntry }),
  z.object({ type: z.literal('balance-changed'), snapshot: balanceSnapshot }),
  z.object({ type: z.literal('budget-crossed'), alert: budgetAlert }),
  z.object({ type: z.literal('status'), status: statusView }),
]) satisfies z.ZodType<TallyWatchFrame>

const routeRequest = z.object({ route: text })

/**
 * Request and result schema of every method. `request` describes the method's single `request`
 * parameter; it is `z.undefined()` for a method that takes none.
 */
export const schemas = {
  status: { request: z.undefined(), result: statusView },
  query: { request: usageQuery, result: z.array(usageGroup) },
  session: { request: z.object({ sessionId: text }), result: sessionView },
  turn: {
    request: z.object({ sessionId: text, fromSeq: z.number().int().min(0), toSeq: z.number().int().min(0) })
      .refine(r => r.fromSeq <= r.toSeq, { message: 'fromSeq must not exceed toSeq', path: ['fromSeq'] }),
    result: turnUsage,
  },
  band: { request: z.object({ route: text, model: text, at: epochMs }), result: bandView.nullable() },
  balance: { request: routeRequest, result: balanceSnapshot.nullable() },
  refreshBalance: { request: routeRequest, result: balanceSnapshot.nullable() },
  budgets: { request: z.undefined(), result: z.array(budget) },
  setBudget: { request: budget, result: z.void() },
  removeBudget: { request: z.object({ id: text }), result: z.void() },
  catalog: { request: z.undefined(), result: catalogView },
  peakSavings: { request: z.object(range).superRefine(checkRange), result: peakSavings },
  exportCsv: { request: z.object({ ...range, tz: timeZone }).superRefine(checkRange), result: z.string() },
  rebuild: { request: z.undefined(), result: z.void() },
  watch: { request: z.undefined(), result: watchFrame },
}

/** Client signatures of the namespace; the declaration merges below are derived from it. */
export interface TallyRemoteApi {
  status: () => Promise<RemoteResult<TallyStatusView>>
  query: (request: UsageQuery) => Promise<RemoteResult<UsageGroup[]>>
  session: (request: { sessionId: string }) => Promise<RemoteResult<SessionView>>
  /** `[fromSeq, toSeq]` is a closed interval of entry sequence numbers. */
  turn: (request: { sessionId: string; fromSeq: number; toSeq: number }) => Promise<RemoteResult<TurnUsage>>
  /** `null` when no price is known for the route and model at that time. */
  band: (request: { route: string; model: string; at: number }) => Promise<RemoteResult<BandView | null>>
  balance: (request: { route: string }) => Promise<RemoteResult<BalanceSnapshot | null>>
  refreshBalance: (request: { route: string }) => Promise<RemoteResult<BalanceSnapshot | null>>
  budgets: () => Promise<RemoteResult<Budget[]>>
  /** Fails with `tally/invalid-budget` when the budget is not acceptable, `tally/write-failed` when the file cannot be written. */
  setBudget: (request: Budget) => Promise<RemoteResult<void>>
  /** Fails with `tally/not-found` when there is no such budget, `tally/write-failed` when the file cannot be written. */
  removeBudget: (request: { id: string }) => Promise<RemoteResult<void>>
  catalog: () => Promise<RemoteResult<CatalogView>>
  peakSavings: (request: { from: number; to: number }) => Promise<RemoteResult<PeakSavings>>
  exportCsv: (request: { from: number; to: number; tz: string }) => Promise<RemoteResult<string>>
  rebuild: () => Promise<RemoteResult<void>>
  /** Stream: `hello` first (and again after an overflow), then recorded, balance and budget events and backfill `status` frames. */
  watch: (signal?: AbortSignal) => RemoteStreamHandle<TallyWatchFrame, never>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'tally/status': TallyRemoteApi['status']
    'tally/query': TallyRemoteApi['query']
    'tally/session': TallyRemoteApi['session']
    'tally/turn': TallyRemoteApi['turn']
    'tally/band': TallyRemoteApi['band']
    'tally/balance': TallyRemoteApi['balance']
    'tally/refreshBalance': TallyRemoteApi['refreshBalance']
    'tally/budgets': TallyRemoteApi['budgets']
    'tally/setBudget': TallyRemoteApi['setBudget']
    'tally/removeBudget': TallyRemoteApi['removeBudget']
    'tally/catalog': TallyRemoteApi['catalog']
    'tally/peakSavings': TallyRemoteApi['peakSavings']
    'tally/exportCsv': TallyRemoteApi['exportCsv']
    'tally/rebuild': TallyRemoteApi['rebuild']
    'tally/watch': TallyRemoteApi['watch']
  }
  interface TypertRemoteNamespaceMap {
    tally: TallyRemoteApi
  }
  interface RemoteErrorDetailsMap {
    /** A budget was refused by validation. */
    'tally/invalid-budget': {}
    /** The named budget does not exist. */
    'tally/not-found': {}
    /** The budget file could not be written (for example the writer lock timed out). */
    'tally/write-failed': {}
  }
}

type Descriptor = TypertRemoteContribution['descriptors'][number]

/**
 * Descriptor of one method. The type symbols name the TypeScript types a generated file would
 * name: `dsh-tally-api#Type` for a type of the API package, `dsh-tally#tally/method:request` or
 * `:result` for an inline one. `hasRequest` is false for a method without a `request` parameter.
 */
function descriptorOf(
  method: keyof typeof schemas,
  hasRequest: boolean,
  symbols: { request?: string; result?: string } = {},
  stream = false,
): Descriptor {
  const { request, result } = schemas[method]
  const symbol = (kind: 'request' | 'result') => symbols[kind] ?? `${PACKAGE}#${NAMESPACE}/${method}:${kind}`
  return {
    id: `${PACKAGE}#${NAMESPACE}/${method}`,
    service: SERVICE,
    namespace: NAMESPACE,
    method,
    ...stream ? { mode: 'stream' as const } : {},
    invocation: { kind: 'direct' },
    parameters: hasRequest
      ? [{
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: symbol('request'), create: () => request },
        }]
      : [],
    // The stream's `signal` is transport cancellation, never a wire argument.
    ...stream ? { cancellation: { parameter: 'signal' as const } } : {},
    result: { mode: 'strict', typeSymbol: symbol('result'), create: () => result },
  }
}

export const TALLY_REMOTE: TypertRemoteContribution = {
  package: PACKAGE,
  descriptors: [
    descriptorOf('status', false, { result: 'dsh-tally-api#TallyStatusView' }),
    descriptorOf('query', true, { request: 'dsh-tally-api#UsageQuery' }),
    descriptorOf('session', true, { result: 'dsh-tally-api#SessionView' }),
    descriptorOf('turn', true, { result: 'dsh-tally-api#TurnUsage' }),
    descriptorOf('band', true, { result: 'dsh-tally-api#BandView' }),
    descriptorOf('balance', true, { result: 'dsh-tally-api#BalanceSnapshot' }),
    descriptorOf('refreshBalance', true, { result: 'dsh-tally-api#BalanceSnapshot' }),
    descriptorOf('budgets', false),
    descriptorOf('setBudget', true, { request: 'dsh-tally-api#Budget' }),
    descriptorOf('removeBudget', true),
    descriptorOf('catalog', false, { result: 'dsh-tally-api#CatalogView' }),
    descriptorOf('peakSavings', true, { result: 'dsh-tally-api#PeakSavings' }),
    descriptorOf('exportCsv', true),
    descriptorOf('rebuild', false),
    descriptorOf('watch', false, { result: 'dsh-tally-api#TallyWatchFrame' }, true),
  ],
}

/** The part of a browser plugin context `mountTallyRemote` needs (`ctx.remote` of `dsh-api-remotes`, `ctx.get`). */
export interface TallyRemoteMountTarget {
  remote: { $mount(contribution: TypertRemoteContribution): unknown }
  /** Cordis service lookup; the Client Remote exposes a mounted namespace as the service `remote.<namespace>`. */
  get?(name: string): unknown
}

/**
 * What a second mount of the contribution fails with. The browser's `$mount` (the api-gateway
 * client) validates first and reports `client api: direct method tally/<method> is already mounted`
 * (or a namespace conflict); the Typert registry behind it reports the package as already registered.
 */
const ALREADY_MOUNTED = [
  new RegExp(`^client api: (?:direct|scoped) method ${NAMESPACE}/\\w+ is already mounted$`),
  new RegExp(`^client api: namespace "${NAMESPACE}" conflicts with an existing Remote namespace$`),
  new RegExp(`Remote package "${PACKAGE}" is already registered`),
]

/**
 * Mounts the `tally` namespace on `ctx.remote`, tolerating another client plugin that mounted it
 * first: when the namespace service `remote.tally` already exists the mount is skipped, and a
 * concurrent mount that loses the race is recognized by its duplicate-mount error. Resolves `true`
 * when this call mounted it (it is withdrawn when `ctx` is disposed) and `false` when it was already
 * there (it then lives as long as the plugin that mounted it). Any other failure rejects.
 */
export async function mountTallyRemote(ctx: TallyRemoteMountTarget): Promise<boolean> {
  if (ctx.get?.(`remote.${NAMESPACE}`) !== undefined) return false
  try {
    await ctx.remote.$mount(TALLY_REMOTE)
    return true
  } catch (error) {
    if (error instanceof Error && ALREADY_MOUNTED.some(pattern => pattern.test(error.message))) return false
    throw error
  }
}

export default TALLY_REMOTE
