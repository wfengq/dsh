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
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {
  BalanceSnapshot, BandView, Budget, CatalogView, PeakSavings, SessionView, TallyEntry, TallyStatusView,
  TurnUsage, UsageGroup, UsageQuery,
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

const range = { from: z.number(), to: z.number() }

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
}) satisfies z.ZodType<BalanceSnapshot>

/** Structure only: whether the id or the amount are acceptable is the budget service's call (`tally/invalid-budget`). */
const budget = z.object({
  id: text,
  period: z.enum(['day', 'month']),
  scope: z.object({ workspaceId: text.optional() }),
  limit: z.object({ amount: text, currency }),
}) satisfies z.ZodType<Budget>

const catalogView = z.object({
  version: z.string(),
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
  band: { request: z.object({ route: text, model: text, at: z.number() }), result: bandView.nullable() },
  balance: { request: routeRequest, result: balanceSnapshot.nullable() },
  refreshBalance: { request: routeRequest, result: balanceSnapshot.nullable() },
  budgets: { request: z.undefined(), result: z.array(budget) },
  setBudget: { request: budget, result: z.void() },
  removeBudget: { request: z.object({ id: text }), result: z.void() },
  catalog: { request: z.undefined(), result: catalogView },
  peakSavings: { request: z.object(range).superRefine(checkRange), result: peakSavings },
  exportCsv: { request: z.object({ ...range, tz: timeZone }).superRefine(checkRange), result: z.string() },
  rebuild: { request: z.undefined(), result: z.void() },
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
  /** Fails with `tally/invalid-budget` when the budget is not acceptable. */
  setBudget: (request: Budget) => Promise<RemoteResult<void>>
  /** Fails with `tally/not-found` when there is no such budget. */
  removeBudget: (request: { id: string }) => Promise<RemoteResult<void>>
  catalog: () => Promise<RemoteResult<CatalogView>>
  peakSavings: (request: { from: number; to: number }) => Promise<RemoteResult<PeakSavings>>
  exportCsv: (request: { from: number; to: number; tz: string }) => Promise<RemoteResult<string>>
  rebuild: () => Promise<RemoteResult<void>>
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
  }
  interface TypertRemoteNamespaceMap {
    tally: TallyRemoteApi
  }
  interface RemoteErrorDetailsMap {
    /** A budget was refused by validation. */
    'tally/invalid-budget': {}
    /** The named budget does not exist. */
    'tally/not-found': {}
  }
}

type Descriptor = TypertRemoteContribution['descriptors'][number]

/**
 * Descriptor of one method. The type symbols name the TypeScript types a generated file would
 * name: `dsh-tally-api#Type` for a type of the API package, `dsh-tally#tally/method:request` or
 * `:result` for an inline one. `hasRequest` is false for a method without a `request` parameter.
 */
function descriptorOf(method: keyof typeof schemas, hasRequest: boolean, symbols: { request?: string; result?: string } = {}): Descriptor {
  const { request, result } = schemas[method]
  const symbol = (kind: 'request' | 'result') => symbols[kind] ?? `${PACKAGE}#${NAMESPACE}/${method}:${kind}`
  return {
    id: `${PACKAGE}#${NAMESPACE}/${method}`,
    service: SERVICE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: hasRequest
      ? [{
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: symbol('request'), create: () => request },
        }]
      : [],
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
  ],
}

export default TALLY_REMOTE
