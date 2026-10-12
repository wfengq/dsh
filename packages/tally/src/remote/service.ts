import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  BalanceSnapshot, BandView, Budget, CatalogView, PeakSavings, SessionView, TallyStatusView, TurnUsage,
  TallyWatchFrame, UsageGroup, UsageQuery,
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

/** Frames a `watch` stream may hold unread before it drops the oldest. */
const WATCH_QUEUE_LIMIT = 1000
/** Least time between two `status` frames of one `watch` stream. */
const WATCH_STATUS_INTERVAL_MS = 1000

interface WatchState {
  queue: TallyWatchFrame[]
  /** Frames were dropped, or the price overrides changed: the next dequeue yields a fresh `hello` first. */
  rehello: boolean
  wake: (() => void) | undefined
  lastStatusAt: number
  timer: ReturnType<typeof setTimeout> | undefined
  /** The stream was closed from outside (the service was disposed): it ends at once. */
  closed: boolean
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

  /** Open `watch` streams, closed when the service is disposed. */
  private readonly watchers = new Set<WatchState>()

  constructor(ctx: Context) {
    super(ctx, 'tallyRemote', { namespace: 'tally' })
    const watchers = this.watchers
    ctx.effect(() => () => {
      for (const state of [...watchers]) {
        state.closed = true
        if (state.timer !== undefined) clearTimeout(state.timer)
        state.timer = undefined
        const resolve = state.wake
        state.wake = undefined
        resolve?.()
      }
      watchers.clear()
    }, 'tallyRemote watch streams')
  }

  // Inside dsh-tally these services are always this package's own implementations.
  private usage(): TallyUsage {
    return this.ctx.tallyUsage as TallyUsage
  }

  private pricing(): TallyPricingService {
    return this.ctx.tallyPricing as TallyPricingService
  }

  /** The status view. `usage.backfill` is `null` unless a backfill or rebuild is in flight right now. */
  private statusView(): TallyStatusView {
    const pricing = this.pricing()
    const balance = this.ctx.tallyBalance as TallyBalance
    const usage = this.ctx.tallyUsage.status()
    return {
      usage: this.usage().backfilling() ? usage : { ...usage, backfill: null },
      catalogVersion: pricing.catalogVersion(),
      pricingErrors: pricing.configErrors.map(e => e.message),
      budgetErrors: this.ctx.tallyBudget.status().errors,
      balanceRoutes: balance.routes(),
      routes: this.knownRoutes(),
    }
  }

  /**
   * Routes dsh has an adapter for plus routes seen in the ledger. `llm` is read without an
   * injection: tally runs without it (headless tests, minimal profiles) and only loses the list.
   */
  private knownRoutes(): string[] {
    const llm = this.ctx.get('llm') as { listProviders?(): Array<{ id: string }> } | undefined
    const configured = llm?.listProviders?.().map(p => p.id) ?? []
    return [...new Set([...configured, ...this.usage().routes()])].sort()
  }

  @Remote
  async status(): Promise<TallyStatusView> {
    return this.statusView()
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

  /** Run a budget edit and wait for its own write, so a failed write is reported instead of a silent success. */
  private async edit(
    waitFor: 'setAndWait' | 'removeAndWait',
    arg: Budget | string,
    fallback: () => void,
  ): Promise<void> {
    const budgets = this.ctx.tallyBudget as unknown as Record<string, ((a: Budget | string) => Promise<void>) | undefined>
    const run = budgets[waitFor]
    try {
      if (run === undefined) fallback()
      else await run.call(this.ctx.tallyBudget, arg)
    } catch (error) {
      throw new RemoteError('tally/write-failed', `tally: could not save the budget file: ${error instanceof Error ? error.message : String(error)}`, {})
    }
  }

  @Remote
  async setBudget(request: unknown): Promise<void> {
    const budget = decode(schemas.setBudget.request, request) as Budget
    const errors = validateBudget(budget)
    if (errors.length > 0) throw new RemoteError('tally/invalid-budget', 'tally: invalid budget: ' + errors.join('; '), {})
    await this.edit('setAndWait', budget, () => this.ctx.tallyBudget.set(budget))
  }

  @Remote
  async removeBudget(request: unknown): Promise<void> {
    const { id } = decode(schemas.removeBudget.request, request)
    if (!this.ctx.tallyBudget.list().some(b => b.id === id)) {
      throw new RemoteError('tally/not-found', `tally: no budget "${id}"`, {})
    }
    await this.edit('removeAndWait', id, () => this.ctx.tallyBudget.remove(id))
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

  /**
   * Live feed for the browser: `hello` first, then ledger, balance and budget events in the
   * order they happen, plus `status` frames (at most one per second) while a backfill or
   * rebuild runs and once more when it ends. The queue holds at most `WATCH_QUEUE_LIMIT`
   * frames; past that the oldest are dropped and a fresh `hello` precedes the next dequeue,
   * so the client refreshes everything; a price-override edit also sends a fresh `hello`, as
   * it re-prices every amount. The hello is taken when the stream is first pulled,
   * and frames queued before an overflow-hello may predate it: a client must refetch its
   * data on every hello instead of applying queued deltas cumulatively. Disposing the
   * service ends every open stream. Aborting `signal` ends the stream and removes every
   * listener and timer.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<TallyWatchFrame> {
    if (signal.aborted) return
    // Plain object: the service may run behind a cordis proxy.
    const state: WatchState = { queue: [], rehello: false, wake: undefined, lastStatusAt: -Infinity, timer: undefined, closed: false }
    const wake = (): void => {
      const resolve = state.wake
      state.wake = undefined
      resolve?.()
    }
    this.watchers.add(state)
    const push = (frame: TallyWatchFrame): void => {
      if (state.closed) return
      state.queue.push(frame)
      if (state.queue.length > WATCH_QUEUE_LIMIT) {
        state.queue.shift()
        state.rehello = true
      }
      wake()
    }
    const pushStatus = (): void => {
      state.timer = undefined
      if (state.closed) return
      state.lastStatusAt = Date.now()
      push({ type: 'status', status: this.statusView() })
    }
    // Progress changes are coalesced: one status frame per interval, always showing the latest state.
    const onProgress = (): void => {
      if (state.closed || state.timer !== undefined) return
      const due = state.lastStatusAt + WATCH_STATUS_INTERVAL_MS - Date.now()
      if (due <= 0) pushStatus()
      else state.timer = setTimeout(pushStatus, due)
    }
    const stops = [
      this.ctx.on('tally/recorded', entry => { push({ type: 'recorded', entry }) }),
      this.ctx.on('tally/balance-changed', snapshot => { push({ type: 'balance-changed', snapshot }) }),
      this.ctx.on('tally/budget-crossed', alert => { push({ type: 'budget-crossed', alert }) }),
      this.usage().watchProgress(onProgress),
      // New price overrides change every amount the client shows: make it refetch everything.
      this.pricing().watchChanges(() => {
        if (state.closed) return
        state.rehello = true
        wake()
      }),
    ]
    signal.addEventListener('abort', wake, { once: true })
    try {
      yield { type: 'hello', status: this.statusView() }
      while (!signal.aborted && !state.closed) {
        if (state.rehello) {
          state.rehello = false
          yield { type: 'hello', status: this.statusView() }
          continue
        }
        const frame = state.queue.shift()
        if (frame !== undefined) {
          yield frame
          continue
        }
        await new Promise<void>((resolve) => { state.wake = resolve })
      }
    } finally {
      state.closed = true
      this.watchers.delete(state)
      for (const stop of stops) stop()
      if (state.timer !== undefined) clearTimeout(state.timer)
      signal.removeEventListener('abort', wake)
    }
  }
}
