/**
 * Browser-side data layer of dsh-tally-ui: turns the `tally` Remote calls and its `watch` stream into
 * subscribable snapshots. The store never accumulates amounts from stream deltas; it refetches from the
 * Host, so a reconnect cannot count anything twice.
 */
import type { TallyRemoteApi } from 'dsh-tally/remote'
import type { BalanceSnapshot, BudgetAlert, SessionView, TallyStatusView, TallyWatchFrame, UsageGroup } from 'dsh-tally-api'

/** The part of `ctx.remote.tally` the store uses. */
export type TallyRemoteFace = Pick<TallyRemoteApi, 'status' | 'query' | 'session' | 'balance' | 'refreshBalance' | 'watch'>

/** A subscribable value, usable as a slot `hooks` observable. */
export interface Snapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface Writable<T> extends Snapshot<T> {
  set(value: T): void
}

function createSnapshot<T>(initial: T): Writable<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      if (Object.is(next, value)) return
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

export interface TallyStoreOptions {
  /** IANA zone whose midnight bounds "today". */
  timeZone: string
  /** Clock, epoch milliseconds; defaults to `Date.now`. */
  now?: () => number
  /** Called when the frame stream fails (not when it ends or is aborted). */
  onError?: (error: unknown) => void
}

export interface TallyStore {
  /**
   * Consumes `frames` (default: a fresh `remote.watch(signal)`) until it ends or `signal` aborts.
   * A plugin that reconnects across carrier generations passes its own merged iterable.
   */
  start(signal: AbortSignal, frames?: AsyncIterable<TallyWatchFrame>): void
  /** Latest status; `null` before the first `hello`. */
  readonly status: Snapshot<TallyStatusView | null>
  /** Latest balance by route; a route that never succeeded carries its error snapshot or is absent. */
  readonly balances: Snapshot<Readonly<Record<string, BalanceSnapshot>>>
  /** Usage of the current local day; `null` until loaded. */
  readonly today: Snapshot<UsageGroup | null>
  /** One session's usage; `null` until loaded. The same instance is returned for the same id. */
  session(sessionId: string): Snapshot<SessionView | null>
  /** Budget alerts not yet shown, oldest first. */
  readonly alerts: Snapshot<readonly BudgetAlert[]>
  dismissAlert(alert: BudgetAlert): void
  /** Asks the Host to query one route's balance now and stores the answer. */
  refreshBalance(route: string): Promise<void>
}

/** Quiet period after the last `recorded` frame before usage is refetched. */
const RECORDED_DEBOUNCE_MS = 500
/** Longest a steady stream of `recorded` frames may postpone the refetch. */
const RECORDED_MAX_WAIT_MS = 5000

/** Offset of `zone` from UTC at `at`, milliseconds. */
function zoneOffset(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(at))
  const n = (type: string) => Number(parts.find(p => p.type === type)!.value)
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(at / 1000) * 1000
}

/** Epoch milliseconds of local midnight of the day containing `at`, `dayShift` days later. */
function localMidnight(at: number, zone: string, dayShift: number): number {
  const local = new Date(at + zoneOffset(at, zone))
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayShift)
  let guess = wall - zoneOffset(at, zone)
  guess = wall - zoneOffset(guess, zone)
  return guess
}

const alertKey = (a: BudgetAlert) => `${a.budgetId}\u0000${a.threshold}\u0000${a.periodStart}`

export function createTallyStore(remote: TallyRemoteFace, opts: TallyStoreOptions): TallyStore {
  const now = opts.now ?? Date.now
  const status = createSnapshot<TallyStatusView | null>(null)
  const balances = createSnapshot<Readonly<Record<string, BalanceSnapshot>>>({})
  const today = createSnapshot<UsageGroup | null>(null)
  const alerts = createSnapshot<readonly BudgetAlert[]>([])
  const sessions = new Map<string, Writable<SessionView | null>>()
  const sessionSeq = new Map<string, number>()
  const knownRoutes = new Set<string>()
  let todaySeq = 0
  let started = false

  async function loadToday(): Promise<void> {
    const seq = ++todaySeq
    const at = now()
    const result = await remote.query({
      from: localMidnight(at, opts.timeZone, 0), to: localMidnight(at, opts.timeZone, 1), groupBy: 'day', tz: opts.timeZone,
    })
    if (seq !== todaySeq || !result.ok) return
    today.set(result.value[0] ?? emptyGroup())
  }

  async function loadSession(sessionId: string): Promise<void> {
    const seq = (sessionSeq.get(sessionId) ?? 0) + 1
    sessionSeq.set(sessionId, seq)
    const result = await remote.session({ sessionId })
    if (sessionSeq.get(sessionId) !== seq || !result.ok) return
    sessions.get(sessionId)?.set(result.value)
  }

  function putBalance(route: string, snapshot: BalanceSnapshot | null): void {
    if (snapshot === null) return
    knownRoutes.add(route)
    balances.set({ ...balances.getSnapshot(), [route]: snapshot })
  }

  async function loadBalance(route: string): Promise<void> {
    const result = await remote.balance({ route })
    if (result.ok) putBalance(route, result.value)
  }

  function reloadAll(): void {
    cancelRecorded()
    void loadToday()
    for (const id of sessions.keys()) void loadSession(id)
    for (const route of [...knownRoutes]) void loadBalance(route)
  }

  // Debounced refetch after `recorded` frames.
  let dueToday = false
  const dueSessions = new Set<string>()
  let quiet: ReturnType<typeof setTimeout> | undefined
  let ceiling: ReturnType<typeof setTimeout> | undefined
  function cancelRecorded(): void {
    clearTimeout(quiet)
    clearTimeout(ceiling)
    quiet = ceiling = undefined
    dueToday = false
    dueSessions.clear()
  }
  function flushRecorded(): void {
    const ids = [...dueSessions]
    const refetchToday = dueToday
    cancelRecorded()
    if (refetchToday) void loadToday()
    for (const id of ids) void loadSession(id)
  }
  function scheduleRecorded(sessionIds: readonly string[]): void {
    dueToday = true
    for (const id of sessionIds) if (sessions.has(id)) dueSessions.add(id)
    clearTimeout(quiet)
    quiet = setTimeout(flushRecorded, RECORDED_DEBOUNCE_MS)
    ceiling ??= setTimeout(flushRecorded, RECORDED_MAX_WAIT_MS)
  }

  function apply(frame: TallyWatchFrame): void {
    switch (frame.type) {
      case 'hello':
        status.set(frame.status)
        for (const route of frame.status.balanceRoutes) knownRoutes.add(route)
        reloadAll()
        break
      case 'status':
        status.set(frame.status)
        break
      case 'recorded':
        scheduleRecorded([frame.entry.sessionId, frame.entry.rootSessionId])
        break
      case 'balance-changed':
        putBalance(frame.snapshot.provider, frame.snapshot)
        break
      case 'budget-crossed': {
        const key = alertKey(frame.alert)
        if (!alerts.getSnapshot().some(a => alertKey(a) === key)) alerts.set([...alerts.getSnapshot(), frame.alert])
        break
      }
    }
  }

  async function consume(signal: AbortSignal, frames: AsyncIterable<TallyWatchFrame>): Promise<void> {
    try {
      for await (const frame of frames) {
        if (signal.aborted) return
        apply(frame)
      }
    } catch (error) {
      if (!signal.aborted) opts.onError?.(error)
    } finally {
      if (signal.aborted) cancelRecorded()
    }
  }

  return {
    start(signal, frames) {
      if (started) throw new Error('the tally store was already started')
      started = true
      if (signal.aborted) return
      const source = frames ?? remote.watch(signal)
      signal.addEventListener('abort', () => { cancelRecorded() }, { once: true })
      void consume(signal, source)
    },
    status,
    balances,
    today,
    alerts,
    session(sessionId) {
      let snapshot = sessions.get(sessionId)
      if (!snapshot) {
        snapshot = createSnapshot<SessionView | null>(null)
        sessions.set(sessionId, snapshot)
        // Before `start` the first `hello` loads it; afterwards it must load itself.
        if (started) void loadSession(sessionId)
      }
      return snapshot
    },
    dismissAlert(alert) {
      const key = alertKey(alert)
      alerts.set(alerts.getSnapshot().filter(a => alertKey(a) !== key))
    },
    async refreshBalance(route) {
      const result = await remote.refreshBalance({ route })
      if (result.ok) putBalance(route, result.value)
    },
  }
}

function emptyGroup(): UsageGroup {
  return {
    key: '', tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: [], requestCount: 0, unpricedCount: 0, unknownUsageCount: 0,
  }
}
