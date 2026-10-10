import { Service, type Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Declares `ctx.sessionQuery` on the cordis Context.
import type {} from '@deepseek-ai/dsh-session-query'
import type {
  SessionUsage, TallyEntry, TallyStatus, UsageGroup, UsageQuery, UsageService,
} from 'dsh-tally-api'
import { TallyPricing, type TallyPricingService } from './pricing-service.js'
import { aggregate, sessionUsage, toUsage } from './query.js'
import { Recorder, type SessionHeaderLike } from './recorder.js'
import { TallyStore, type StoredEntry } from './store.js'

export interface TallyUsageConfig {
  /** SQLite ledger file. */
  dbPath: string
  /** Sessions read concurrently per backfill batch. */
  backfillBatch: number
}

/** Older errors are dropped beyond this many, so a persistently failing source cannot grow memory. */
const MAX_ERRORS = 100

const ALL_TIME = { from: Number.MIN_SAFE_INTEGER, to: Number.MAX_SAFE_INTEGER }

interface BackfillRun {
  controller: AbortController
  /** Settles (never rejects) once the run stopped; a run always finishes the batch it read. */
  done: Promise<void>
}

/** Mutable runtime state, kept in one plain object because service methods may run on a cordis proxy. */
interface UsageState {
  readonly lifetime: AbortController
  run: BackfillRun | undefined
  /** Settles once the initial backfill was started or cancelled. */
  scheduled: Promise<void>
  rebuilding: Promise<void>
  progress: { done: number; total: number } | null
  errors: TallyStatus['errors']
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * `ctx.tallyUsage`: the cost ledger.
 *
 * Live: every own `session/event` is folded into the ledger right away. History: after the
 * service starts, a background backfill replays every session from `ctx.sessionQuery` in
 * batches. Both write through the same per-session cursor and the `(sessionId, seq)` key, so
 * they merge without duplicates in any order.
 */
export class TallyUsage extends Service implements UsageService {
  static inject = ['sessionQuery', 'tallyPricing']

  private readonly store: TallyStore
  private readonly recorder: Recorder
  private readonly headers = new Map<string, SessionHeaderLike>()
  private readonly batchSize: number
  private readonly state: UsageState

  constructor(ctx: Context, config: TallyUsageConfig) {
    super(ctx, 'tallyUsage')
    this.batchSize = Math.max(1, Math.floor(config.backfillBatch))
    this.store = TallyStore.open(config.dbPath)
    this.recorder = new Recorder(this.store, e => this.emitRecorded(e), id => this.headers.get(id))
    let started!: () => void
    const state: UsageState = this.state = {
      lifetime: new AbortController(),
      run: undefined,
      scheduled: new Promise<void>(resolve => { started = resolve }),
      rebuilding: Promise.resolve(),
      progress: null,
      errors: [],
    }

    // Registered first so it runs last: listeners and the timer are gone before the store closes.
    ctx.effect(() => async () => {
      state.lifetime.abort(new Error('dsh-tally: tallyUsage disposed'))
      for (;;) {
        const run = state.run
        await Promise.allSettled([run?.done, state.rebuilding])
        if (state.run === run) break
      }
      this.store.close()
    }, 'tallyUsage lifecycle')

    ctx.on('session/created', (session) => {
      this.headers.set(session.id, session.header)
    })
    ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))

    // Backfill in the background so plugin startup never waits on reading history.
    ctx.effect(() => {
      const timer = setTimeout(() => {
        started()
        if (state.run === undefined && !state.lifetime.signal.aborted) this.startBackfill()
      }, 0)
      return () => {
        clearTimeout(timer)
        started()
      }
    }, 'tallyUsage backfill')
  }

  async query(q: UsageQuery): Promise<UsageGroup[]> {
    const pricing = this.pricing()
    const f = q.filter ?? {}
    let entries = this.store.entries({ from: q.from, to: q.to, model: f.model, rootSessionId: f.rootSessionId })
    if (f.provider !== undefined) entries = entries.filter(e => pricing.providerOf(e.route) === f.provider)
    if (f.workspaceId !== undefined) entries = entries.filter(e => e.workspaceId === f.workspaceId)
    if (f.band !== undefined) entries = entries.filter(e => quoteEntry(pricing, e)?.band === f.band)
    return aggregate(entries, pricing, q.groupBy, q.tz ?? hostTimeZone())
  }

  /**
   * Usage of a root session and its sub-agents. For a session that is not a root (a
   * sub-agent), the total covers that session's own entries.
   */
  async session(sessionId: string): Promise<SessionUsage> {
    let entries = this.store.entries({ ...ALL_TIME, rootSessionId: sessionId })
    if (entries.length === 0) entries = this.store.entries({ ...ALL_TIME, sessionIds: [sessionId] })
    return sessionUsage(entries, sessionId, this.pricing())
  }

  /** Drop the whole ledger and replay every session log; resolves when the replay finished. */
  rebuild(): Promise<void> {
    const state = this.state
    const next = state.rebuilding.catch(() => {}).then(async () => {
      this.assertActive()
      const previous = state.run
      previous?.controller.abort(new Error('dsh-tally: superseded by rebuild'))
      await previous?.done
      this.assertActive()
      this.store.reset()
      state.errors = []
      state.progress = null
      await this.startBackfill().done
    })
    state.rebuilding = next
    return next
  }

  status(): TallyStatus {
    const { progress, errors } = this.state
    return {
      backfill: progress === null ? null : { ...progress },
      errors: [...this.pricingService().configErrors, ...errors].map(e => ({ ...e })),
    }
  }

  /** Resolves once the scheduled backfill and any rebuild have finished (not part of `UsageService`). */
  async idle(): Promise<void> {
    const state = this.state
    await state.scheduled
    for (;;) {
      const run = state.run
      await Promise.allSettled([run?.done, state.rebuilding])
      if (state.run === run) return
    }
  }

  private assertActive(): void {
    if (this.state.lifetime.signal.aborted) throw new Error('dsh-tally: tallyUsage is disposed')
  }

  private pricingService(): TallyPricingService {
    const service = this.ctx.tallyPricing as unknown as Partial<TallyPricingService>
    if (!(service.pricing instanceof TallyPricing)) {
      throw new Error('dsh-tally: ctx.tallyPricing is not the dsh-tally pricing service')
    }
    return service as TallyPricingService
  }

  private pricing(): TallyPricing {
    return this.pricingService().pricing
  }

  private fail(sessionId: string | undefined, error: unknown): void {
    const message = messageOf(error)
    const errors = this.state.errors
    errors.push(sessionId === undefined ? { message } : { sessionId, message })
    if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS)
    this.ctx.logger.warn(sessionId === undefined ? message : `session "${sessionId}": ${message}`)
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (this.state.lifetime.signal.aborted || !session.isOwnSeq(event.seq)) return
    const id: string = session.id
    this.headers.set(id, session.header)
    try {
      const last = this.recorder.lastSeq(id)
      if (last !== undefined && event.seq <= last) return
      const expected = last === undefined ? session.inheritedEventCount : last + 1
      // Fast path: the event directly follows what is folded already. Otherwise (first event
      // after a restart or rebuild, or a gap) refold from the session's own log; the cursor
      // skips everything already recorded. `ingest` is synchronous, so calls never interleave.
      const events = event.seq === expected ? [event] : session.ownEvents()
      this.recorder.ingest(id, session.header, events)
    } catch (error) {
      this.fail(id, error)
    }
  }

  private startBackfill(): BackfillRun {
    const controller = new AbortController()
    const signal = AbortSignal.any([this.state.lifetime.signal, controller.signal])
    const run: BackfillRun = { controller, done: this.backfill(signal) }
    this.state.run = run
    return run
  }

  private async backfill(signal: AbortSignal): Promise<void> {
    const state = this.state
    try {
      const query = this.ctx.sessionQuery
      const records = await query.listSessions(signal)
      if (signal.aborted) return
      for (const record of records) this.headers.set(record.header.id, record.header)
      const progress = { done: 0, total: records.length }
      state.progress = progress
      for (let i = 0; i < records.length && !signal.aborted; i += this.batchSize) {
        const batch = records.slice(i, i + this.batchSize)
        const reads = await Promise.allSettled(batch.map(r => query.readSession(r.header.id)))
        // A batch that was read is always recorded, so disposal waits for at most one batch.
        reads.forEach((read, k) => {
          const id: string = batch[k]!.header.id
          if (read.status === 'rejected') {
            this.fail(id, read.reason)
            return
          }
          const log = read.value
          this.headers.set(id, log.session)
          try {
            this.recorder.ingest(id, log.session, log.events.filter(e => e.seq >= log.inheritedEventCount))
          } catch (error) {
            this.fail(id, error)
          }
        })
        progress.done += batch.length
      }
    } catch (error) {
      if (!signal.aborted) this.fail(undefined, new Error(`Backfill failed: ${messageOf(error)}`))
    }
  }

  private emitRecorded(e: StoredEntry): void {
    let entry: TallyEntry
    try {
      const pricing = this.pricing()
      const q = quoteEntry(pricing, e)
      entry = {
        id: e.id,
        sessionId: e.sessionId,
        rootSessionId: e.rootSessionId,
        ...e.workspaceId === null ? {} : { workspaceId: e.workspaceId },
        at: e.at,
        route: e.route,
        provider: pricing.providerOf(e.route),
        model: e.model,
        band: q?.band ?? null,
        tokens: { ...e.tokens },
        // Unknown usage is never priced.
        cost: e.usageKnown && q !== null ? { amount: q.amount, currency: q.currency } : null,
        priceVersion: q?.priceVersion ?? null,
        usageKnown: e.usageKnown,
      }
    } catch (error) {
      this.ctx.logger.warn(`tally/recorded for ${e.id} skipped: ${messageOf(error)}`)
      return
    }
    try {
      this.ctx.emit('tally/recorded', entry)
    } catch (error) {
      this.ctx.logger.warn(`tally/recorded listener failed for ${e.id}: ${messageOf(error)}`)
    }
  }
}

function quoteEntry(pricing: TallyPricing, e: StoredEntry) {
  return pricing.quoteRoute(e.route, e.model, toUsage(e.tokens), e.at)
}
