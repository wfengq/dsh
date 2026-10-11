import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  BalanceFetcher, BalanceService, BalanceSnapshot, TallyEntry, Wallet,
} from 'dsh-tally-api'

export interface TallyBalanceConfig {
  /** Quiet period after the last `tally/recorded` of a route before it is refreshed. */
  debounceMs: number
  /** Minimum time between the starts of two automatic refreshes of one route. */
  minIntervalMs: number
  /** A request still pending after this long is aborted. */
  timeoutMs: number
}

/** Everything known about one registered route. */
interface Route {
  readonly fetcher: BalanceFetcher
  snapshot: BalanceSnapshot | undefined
  inflight: { promise: Promise<BalanceSnapshot>; controller: AbortController } | undefined
  /** Pending debounce or deferral timer for an automatic refresh. */
  timer: ReturnType<typeof setTimeout> | undefined
  /** `timer` waits for `lastAutoAt + minIntervalMs`; further triggers neither shorten nor extend it. */
  deferred: boolean
  /** Time of the first trigger of the pending automatic refresh; bounds how long debouncing may postpone it. */
  pendingSince: number | undefined
  /** Start time of the last automatic refresh. */
  lastAutoAt: number | undefined
}

/** Mutable runtime state, kept in one plain object because service methods may run on a cordis proxy. */
interface BalanceState {
  readonly lifetime: AbortController
  readonly routes: Map<string, Route>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameWallets(a: readonly Wallet[], b: readonly Wallet[]): boolean {
  return a.length === b.length && a.every((w, i) => {
    const o = b[i]!
    return w.kind === o.kind && w.money.amount === o.money.amount && w.money.currency === o.money.currency
  })
}

/**
 * `ctx.tallyBalance`: a registry of per-route balance fetchers with caching.
 *
 * It never reads credentials and never opens a connection itself; fetchers come from provider
 * plugins. A failed fetch never shows as zero: the previous wallets are kept and marked stale.
 * Each `tally/recorded` of a route with a fetcher schedules a debounced automatic refresh.
 */
export class TallyBalance extends Service implements BalanceService {
  private readonly config: TallyBalanceConfig
  private readonly state: BalanceState

  constructor(ctx: Context, config: TallyBalanceConfig) {
    super(ctx, 'tallyBalance')
    this.config = { ...config }
    const state: BalanceState = this.state = { lifetime: new AbortController(), routes: new Map() }

    ctx.effect(() => () => {
      state.lifetime.abort(new Error('dsh-tally: tallyBalance disposed'))
      for (const route of state.routes.values()) this.release(route)
      state.routes.clear()
    }, 'tallyBalance lifecycle')

    ctx.on('tally/recorded', (entry: TallyEntry) => this.onRecorded(entry.route))
  }

  register(route: string, fetcher: BalanceFetcher): () => void {
    const routes = this.state.routes
    if (routes.has(route)) throw new Error('tally: balance provider already registered: ' + route)
    const entry: Route = { fetcher, snapshot: undefined, inflight: undefined, timer: undefined, deferred: false, pendingSince: undefined, lastAutoAt: undefined }
    routes.set(route, entry)
    return () => {
      if (routes.get(route) !== entry) return
      routes.delete(route)
      this.release(entry)
    }
  }

  async get(route: string): Promise<BalanceSnapshot | null> {
    const entry = this.state.routes.get(route)
    if (entry === undefined) return null
    return entry.snapshot ?? this.refresh(route)
  }

  refresh(route: string): Promise<BalanceSnapshot | null> {
    const entry = this.state.routes.get(route)
    if (entry === undefined) return Promise.resolve(null)
    return entry.inflight?.promise ?? this.runFetcher(route, entry)
  }

  /** Stop everything a route owns: its timer and its in-flight request. */
  private release(entry: Route): void {
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.deferred = false
    entry.pendingSince = undefined
    entry.inflight?.controller.abort(new Error('dsh-tally: balance provider disposed'))
  }

  private onRecorded(route: string): void {
    const entry = this.state.routes.get(route)
    if (entry === undefined || this.state.lifetime.signal.aborted) return
    // A refresh is already waiting for the minimum interval; it will cover this entry too.
    if (entry.deferred) return
    const now = Date.now()
    entry.pendingSince ??= now
    // Debounce, but never postpone the refresh more than `minIntervalMs` after the first trigger,
    // so a steady stream of entries cannot starve it.
    const delay = Math.max(0, Math.min(this.config.debounceMs, entry.pendingSince + this.config.minIntervalMs - now))
    this.arm(route, entry, delay, false)
  }

  private arm(route: string, entry: Route, delay: number, deferred: boolean): void {
    clearTimeout(entry.timer)
    entry.deferred = deferred
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      entry.deferred = false
      if (this.state.routes.get(route) !== entry) return
      const now = Date.now()
      const earliest = entry.lastAutoAt === undefined ? now : entry.lastAutoAt + this.config.minIntervalMs
      if (now < earliest) return this.arm(route, entry, earliest - now, true)
      entry.pendingSince = undefined
      entry.lastAutoAt = now
      void this.refresh(route)
    }, delay)
  }

  private runFetcher(route: string, entry: Route): Promise<BalanceSnapshot> {
    const { timeoutMs } = this.config
    const controller = new AbortController()
    const signal = controller.signal
    const timer = setTimeout(() => {
      controller.abort(new Error(`balance request timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    // Aborts the request when the service is disposed; the route's own dispose aborts `controller` directly.
    const lifetime = this.state.lifetime.signal
    const onDispose = () => controller.abort(lifetime.reason)
    lifetime.addEventListener('abort', onDispose, { once: true })

    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })
    const promise = (async () => {
      let wallets: Wallet[] | undefined
      let error: unknown
      try {
        // Raced with the signal so a fetcher that ignores it cannot hang the refresh.
        wallets = await Promise.race([new Promise<Wallet[]>(resolve => resolve(entry.fetcher(signal))), aborted])
      } catch (e) {
        error = e
      } finally {
        clearTimeout(timer)
        lifetime.removeEventListener('abort', onDispose)
      }
      const current = this.state.routes.get(route) === entry
      if (current) entry.inflight = undefined
      return this.settle(route, entry, current, wallets, error)
    })()
    entry.inflight = { promise, controller }
    return promise
  }

  /** Build the snapshot of a finished request; cache and announce it only if the route is still registered. */
  private settle(route: string, entry: Route, current: boolean, wallets: Wallet[] | undefined, error: unknown): BalanceSnapshot {
    const prev = entry.snapshot
    let snap: BalanceSnapshot
    let changed: boolean
    if (wallets !== undefined) {
      snap = { provider: route, wallets, fetchedAt: Date.now(), stale: false }
      changed = prev === undefined || prev.stale || !sameWallets(prev.wallets, wallets)
    } else {
      const message = messageOf(error)
      snap = prev === undefined
        ? { provider: route, wallets: [], fetchedAt: Date.now(), stale: true, error: message }
        : { ...prev, stale: true, error: message }
      changed = true
    }
    if (current) {
      entry.snapshot = snap
      if (changed) this.announce(snap)
    }
    return snap
  }

  private announce(snap: BalanceSnapshot): void {
    try {
      this.ctx.emit('tally/balance-changed', snap)
    } catch (error) {
      this.ctx.logger.warn(`tally/balance-changed listener failed for ${snap.provider}: ${messageOf(error)}`)
    }
  }
}
