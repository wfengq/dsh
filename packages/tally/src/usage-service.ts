import { Service, type Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
// Declares `ctx.sessionQuery` on the cordis Context.
import type {} from '@deepseek-ai/dsh-session-query'
import { addFixed, formatFixed, parseAmount, type Fixed } from 'dsh-pricing-data'
import type {
  Money, PeakSavings, SessionUsage, SessionView, TallyEntry, TallyStatus, TurnUsage, UsageGroup, UsageQuery, UsageService,
} from 'dsh-tally-api'
import { withoutInterruptedClosers } from './cold-log.js'
import { TallyPricing, type TallyPricingService } from './pricing-service.js'
import { CSV_HEADER, csvLine, csvRow } from './csv.js'
import { aggregate, groupOf, sessionUsage, toUsage } from './query.js'
import { Recorder, type SessionHeaderLike } from './recorder.js'
import { TallyStore, type StoredEntry, type UsageRow } from './store.js'

export interface TallyUsageConfig {
  /** SQLite ledger file. */
  dbPath: string
  /** Sessions read concurrently per backfill batch. */
  backfillBatch: number
}

/** Older errors are dropped beyond this many, so a persistently failing source cannot grow memory. */
const MAX_ERRORS = 100

const ALL_TIME = { from: Number.MIN_SAFE_INTEGER, to: Number.MAX_SAFE_INTEGER }

/** Meta key set once a backfill pass over every listed session has finished. */
const BACKFILL_COMPLETE = 'backfillComplete'

const nextTick = () => new Promise<void>(resolve => setImmediate(resolve))

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
  /** Backfill runs and rebuilds in flight; `progress` alone cannot tell, as it keeps its last value after a run. */
  busy: number
  /** Internal observers of `busy` and `progress` changes (see `watchProgress`). */
  observers: Set<() => void>
  errors: TallyStatus['errors']
  /** `ctx.sessions` while it is available, for headers of live sessions not yet listed. */
  sessions: SessionStore | undefined
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
 * Live: every own `session/event` is folded into the ledger right away and announced with
 * `tally/recorded`. History: after the service starts, a background backfill replays sessions
 * from `ctx.sessionQuery` in batches, without announcing them. The first pass reads every
 * session; once it completed, later starts read only sessions without a cursor or stopped
 * inside a turn. Both paths write through the same per-session cursor and the
 * `(sessionId, seq)` key, so they merge without duplicates in any order.
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
    this.recorder = new Recorder(
      this.store,
      e => this.emitRecorded(e),
      id => this.headers.get(id) ?? this.state.sessions?.get(id as SessionId)?.header,
    )
    let started!: () => void
    const state: UsageState = this.state = {
      lifetime: new AbortController(),
      run: undefined,
      scheduled: new Promise<void>(resolve => { started = resolve }),
      rebuilding: Promise.resolve(),
      progress: null,
      busy: 0,
      observers: new Set(),
      errors: [],
      sessions: undefined,
    }

    // Disposal aborts synchronously; the live path, the backfill timer and rebuild all check the
    // abort signal before touching the store, and the store closes only after the in-flight
    // backfill or rebuild settled (a backfill finishes recording the batch it already read).
    ctx.effect(() => async () => {
      state.lifetime.abort(new Error('dsh-tally: tallyUsage disposed'))
      for (;;) {
        const run = state.run
        await Promise.allSettled([run?.done, state.rebuilding])
        if (state.run === run) break
      }
      this.store.close()
    }, 'tallyUsage lifecycle')

    // Optional: the live session store resolves sub-agent parents that are not listed yet.
    ctx.inject(['sessions'], (inner) => {
      const sessions = inner.sessions
      state.sessions = sessions
      inner.effect(() => () => {
        if (state.sessions === sessions) state.sessions = undefined
      }, 'tallyUsage sessions binding')
    })

    ctx.on('session/created', (session) => {
      this.headers.set(session.id, session.header)
    })
    ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))

    // Backfill in the background so plugin startup never waits on reading history.
    ctx.effect(() => {
      const timer = setTimeout(() => {
        started()
        if (state.run === undefined && !state.lifetime.signal.aborted) this.startBackfill(false)
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
    let entries = this.store.usage({ from: q.from, to: q.to, model: f.model, rootSessionId: f.rootSessionId })
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
    let entries = this.store.usage({ ...ALL_TIME, rootSessionId: sessionId })
    if (entries.length === 0) entries = this.store.usage({ ...ALL_TIME, sessionIds: [sessionId] })
    return sessionUsage(entries, sessionId, this.pricing())
  }

  /** A session's usage with the route and model of its own latest request. */
  async sessionView(sessionId: string): Promise<SessionView> {
    const latest = this.store.latestSessionEntry(sessionId)
    return {
      usage: await this.session(sessionId),
      lastRoute: latest?.route ?? null,
      lastModel: latest?.model ?? null,
    }
  }

  /** The entries of one session whose `seq` lies in the closed interval `[fromSeq, toSeq]`, oldest first, with their total. */
  async turn(sessionId: string, fromSeq: number, toSeq: number): Promise<TurnUsage> {
    const stored = this.store.sessionEntries(sessionId, { from: fromSeq, to: toSeq })
    return {
      total: groupOf(stored, this.pricing(), sessionId),
      attempts: stored.map(e => this.entryOf(e)),
    }
  }

  /** The ledger rows with `from <= at < to` as UTF-8 CSV, oldest first; times are written in `tz`. */
  async exportCsv(from: number, to: number, tz: string): Promise<string> {
    const stored = this.store.entries({ from, to }).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return csvLine(CSV_HEADER) + stored.map(e => csvRow(this.entryOf(e), tz)).join('')
  }

  /**
   * What the peak-band requests of `[from, to)` cost against the same tokens at the off-peak
   * rate, per currency. A request counts only when both prices are known.
   */
  async peakSavings(from: number, to: number): Promise<PeakSavings> {
    const pricing = this.pricing()
    const totals = new Map<Money['currency'], { peak: Fixed; offpeak: Fixed }>()
    for (const e of this.store.usage({ from, to })) {
      if (!e.usageKnown) continue
      const usage = toUsage(e.tokens)
      const peak = pricing.quoteRoute(e.route, e.model, usage, e.at)
      if (peak?.band !== 'peak') continue
      const offpeak = pricing.quoteRoute(e.route, e.model, usage, e.at, 'offpeak')
      if (offpeak === null || offpeak.currency !== peak.currency) continue
      const sum = totals.get(peak.currency) ?? { peak: { units: 0n }, offpeak: { units: 0n } }
      sum.peak = addFixed(sum.peak, parseAmount(peak.amount))
      sum.offpeak = addFixed(sum.offpeak, parseAmount(offpeak.amount))
      totals.set(peak.currency, sum)
    }
    const currencies = [...totals.keys()].sort()
    const money = (pick: (t: { peak: Fixed; offpeak: Fixed }) => Fixed): Money[] =>
      currencies.map(currency => ({ amount: formatSigned(pick(totals.get(currency)!)), currency }))
    return {
      peak: money(t => t.peak),
      offpeakEquivalent: money(t => t.offpeak),
      saving: money(t => ({ units: t.peak.units - t.offpeak.units })),
    }
  }

  /** Drop the whole ledger and replay every session log; resolves when the replay finished. Emits no `tally/recorded`. */
  rebuild(): Promise<void> {
    const state = this.state
    state.busy++
    this.notifyProgress()
    const next = state.rebuilding.catch(() => {}).then(async () => {
      this.assertActive()
      const previous = state.run
      previous?.controller.abort(new Error('dsh-tally: superseded by rebuild'))
      await previous?.done
      this.assertActive()
      this.store.reset()
      state.errors = []
      state.progress = null
      await this.startBackfill(true).done
    }).finally(() => {
      state.busy--
      this.notifyProgress()
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

  /** Whether a backfill pass or a rebuild is in flight right now. Internal: not part of `UsageService`. */
  backfilling(): boolean {
    return this.state.busy > 0
  }

  /**
   * Calls `observer` whenever a backfill or rebuild starts, advances or ends; returns the
   * unsubscribe function. Internal (used by the `watch` stream): not part of `UsageService`,
   * and not a cordis event, so the public event surface stays unchanged.
   */
  watchProgress(observer: () => void): () => void {
    const observers = this.state.observers
    observers.add(observer)
    return () => { observers.delete(observer) }
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

  private notifyProgress(): void {
    for (const observer of [...this.state.observers]) {
      try {
        observer()
      } catch (error) {
        this.ctx.logger.warn(`progress observer failed: ${messageOf(error)}`)
      }
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
      // skips everything already recorded. Only attempts settled by this event are live: what
      // the earlier events settle is history and is recorded without `tally/recorded`.
      // `ingest` is synchronous, so calls never interleave.
      if (event.seq !== expected) {
        const history = session.ownEvents().filter(e => e.seq < event.seq)
        this.recorder.ingest(id, session.header, history, { notify: false })
      }
      this.recorder.ingest(id, session.header, [event])
    } catch (error) {
      this.fail(id, error)
    }
  }

  private startBackfill(full: boolean): BackfillRun {
    const controller = new AbortController()
    const signal = AbortSignal.any([this.state.lifetime.signal, controller.signal])
    const state = this.state
    state.busy++
    this.notifyProgress()
    const run: BackfillRun = {
      controller,
      done: this.backfill(signal, full).finally(() => {
        state.busy--
        this.notifyProgress()
      }),
    }
    state.run = run
    return run
  }

  /**
   * Replay sessions into the ledger. A full pass reads every listed session; otherwise (after
   * a full pass completed once) only sessions without a cursor or stopped inside a turn.
   */
  private async backfill(signal: AbortSignal, full: boolean): Promise<void> {
    const state = this.state
    try {
      const query = this.ctx.sessionQuery
      const records = await query.listSessions(signal)
      if (signal.aborted) return
      for (const record of records) this.headers.set(record.header.id, record.header)
      const all = full || this.store.getMeta(BACKFILL_COMPLETE) === undefined
      const todo = all ? records : records.filter(r => !this.recorder.isSettled(r.header.id))
      const progress = { done: 0, total: todo.length }
      state.progress = progress
      this.notifyProgress()
      for (let i = 0; i < todo.length && !signal.aborted; i += this.batchSize) {
        const batch = todo.slice(i, i + this.batchSize)
        const reads = await Promise.allSettled(batch.map(r => query.readSession(r.header.id)))
        // A batch that was read is always recorded, so disposal waits for at most one batch.
        for (let k = 0; k < batch.length; k++) {
          if (k > 0) await nextTick()
          const read = reads[k]!
          const id: string = batch[k]!.header.id
          if (read.status === 'rejected') {
            this.fail(id, read.reason)
          } else {
            const log = read.value
            this.headers.set(id, log.session)
            // A cold read closes an open tail turn with synthetic events; never record those.
            // (Stripping is applied to every read: an exact match is only ever such closers.)
            const own = withoutInterruptedClosers(log.events).filter(e => e.seq >= log.inheritedEventCount)
            try {
              this.recorder.ingest(id, log.session, own, { notify: false })
            } catch (error) {
              this.fail(id, error)
            }
          }
          progress.done++
          this.notifyProgress()
        }
        await nextTick()
      }
      if (!signal.aborted) this.store.setMeta(BACKFILL_COMPLETE, String(Date.now()))
    } catch (error) {
      if (!signal.aborted) this.fail(undefined, new Error(`Backfill failed: ${messageOf(error)}`))
    }
  }

  /** The public view of a stored entry: priced with the current rules. */
  private entryOf(e: StoredEntry): TallyEntry {
    const pricing = this.pricing()
    // Unknown usage is never priced, so it has no band or price version either.
    const q = e.usageKnown ? quoteEntry(pricing, e) : null
    return {
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
      cost: q === null ? null : { amount: q.amount, currency: q.currency },
      priceVersion: q?.priceVersion ?? null,
      usageKnown: e.usageKnown,
    }
  }

  private emitRecorded(e: StoredEntry): void {
    let entry: TallyEntry
    try {
      entry = this.entryOf(e)
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

/** Decimal string of a fixed-point value that may be negative. */
function formatSigned(f: Fixed): string {
  return f.units < 0n ? '-' + formatFixed({ units: -f.units }) : formatFixed(f)
}

function quoteEntry(pricing: TallyPricing, e: UsageRow) {
  return pricing.quoteRoute(e.route, e.model, toUsage(e.tokens), e.at)
}
