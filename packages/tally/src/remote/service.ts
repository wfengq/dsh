import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  BalanceSnapshot, BandView, Budget, CatalogView, PeakSavings, SessionView, TallyStatusView, TurnUsage,
  UsageGroup, UsageQuery,
} from 'dsh-tally-api'
import type { z } from 'zod'
import type { TallyBalance } from '../balance-service.js'
import { validateBudget } from '../budget-file.js'
import type { TallyPricingService } from '../pricing-service.js'
import type { TallyUsage } from '../usage-service.js'
import { schemas } from './contract.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tallyRemote: TallyRemote
  }
}

/** Decodes a request with the contract's schema; a malformed one fails as `gateway/bad-request`. */
function decode<Schema extends z.ZodType>(schema: Schema, request: unknown): z.output<Schema> {
  const parsed = schema.safeParse(request)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const where = issue === undefined || issue.path.length === 0 ? '' : ` (${issue.path.join('.')})`
  throw new RemoteError(
    'gateway/bad-request',
    `tally: invalid request${where}: ${issue?.message ?? 'malformed'}`,
    { issues: parsed.error.issues },
  )
}

/**
 * `ctx.tallyRemote`: the `tally` Remote namespace, callable from the browser through the dsh
 * API Gateway. Methods only read and delegate to the other tally services; every method with a
 * request validates it with the contract's schema first.
 *
 * Parameter names matter: the Gateway's source-mode fallback reads them from the compiled
 * function, so a method takes no parameters or a single `request` object (typed `unknown`
 * because it is untrusted until decoded).
 */
export class TallyRemote extends TypertRemoteService {
  static inject = ['tallyUsage', 'tallyPricing', 'tallyBalance', 'tallyBudget']

  constructor(ctx: Context) {
    super(ctx, 'tallyRemote', { namespace: 'tally' })
  }

  // Inside dsh-tally these services are always this package's own implementations.
  private usage(): TallyUsage {
    return this.ctx.tallyUsage as TallyUsage
  }

  private pricing(): TallyPricingService {
    return this.ctx.tallyPricing as TallyPricingService
  }

  @Remote
  async status(): Promise<TallyStatusView> {
    const pricing = this.pricing()
    const balance = this.ctx.tallyBalance as TallyBalance
    return {
      usage: this.ctx.tallyUsage.status(),
      catalogVersion: pricing.catalogVersion(),
      pricingErrors: pricing.configErrors.map(e => e.message),
      budgetErrors: this.ctx.tallyBudget.status().errors,
      balanceRoutes: balance.routes(),
    }
  }

  @Remote
  async query(request: unknown): Promise<UsageGroup[]> {
    return this.usage().query(decode(schemas.query.request, request) as UsageQuery)
  }

  @Remote
  async session(request: unknown): Promise<SessionView> {
    const { sessionId } = decode(schemas.session.request, request)
    return this.usage().sessionView(sessionId)
  }

  @Remote
  async turn(request: unknown): Promise<TurnUsage> {
    const { sessionId, fromSeq, toSeq } = decode(schemas.turn.request, request)
    return this.usage().turn(sessionId, fromSeq, toSeq)
  }

  @Remote
  async band(request: unknown): Promise<BandView | null> {
    const { route, model, at } = decode(schemas.band.request, request)
    return this.pricing().pricing.bandOf(route, model, at)
  }

  @Remote
  async balance(request: unknown): Promise<BalanceSnapshot | null> {
    return this.ctx.tallyBalance.get(decode(schemas.balance.request, request).route)
  }

  @Remote
  async refreshBalance(request: unknown): Promise<BalanceSnapshot | null> {
    return this.ctx.tallyBalance.refresh(decode(schemas.refreshBalance.request, request).route)
  }

  @Remote
  async budgets(): Promise<Budget[]> {
    return this.ctx.tallyBudget.list()
  }

  @Remote
  async setBudget(request: unknown): Promise<void> {
    const budget = decode(schemas.setBudget.request, request) as Budget
    const errors = validateBudget(budget)
    if (errors.length > 0) throw new RemoteError('tally/invalid-budget', 'tally: invalid budget: ' + errors.join('; '), {})
    this.ctx.tallyBudget.set(budget)
  }

  @Remote
  async removeBudget(request: unknown): Promise<void> {
    const { id } = decode(schemas.removeBudget.request, request)
    if (!this.ctx.tallyBudget.list().some(b => b.id === id)) {
      throw new RemoteError('tally/not-found', `tally: no budget "${id}"`, {})
    }
    this.ctx.tallyBudget.remove(id)
  }

  @Remote
  async catalog(): Promise<CatalogView> {
    return this.pricing().pricing.catalogView(Date.now())
  }

  @Remote
  async peakSavings(request: unknown): Promise<PeakSavings> {
    const { from, to } = decode(schemas.peakSavings.request, request)
    return this.usage().peakSavings(from, to)
  }

  @Remote
  async exportCsv(request: unknown): Promise<string> {
    const { from, to, tz } = decode(schemas.exportCsv.request, request)
    return this.usage().exportCsv(from, to, tz)
  }

  @Remote
  async rebuild(): Promise<void> {
    await this.usage().rebuild()
  }
}
