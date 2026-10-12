/**
 * Browser-side data layer of dsh-tally-ui: turns the `tally` Remote calls and its `watch` stream into
 * subscribable snapshots. The store never accumulates amounts from stream deltas; it refetches from the
 * Host, so a reconnect cannot count anything twice.
 */
import type { TallyRemoteApi } from 'dsh-tally/remote'
import type { BalanceSnapshot, Budget, BudgetAlert, Currency, Money, SessionView, TallyStatusView, TallyWatchFrame, UsageGroup } from 'dsh-tally-api'
import { spentIn } from './budget-progress.ts'
import { addDecimal } from './dashboard/decimal.ts'

/** The part of `ctx.remote.tally` the store uses. */
export type TallyRemoteFace = Pick<TallyRemoteApi, 'status' | 'query' | 'session' | 'balance' | 'refreshBalance' | 'budgets' | 'watch'>

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
  /**
   * Number of `hello` frames seen so far. Every `hello` may come with new prices, a rebuilt ledger or a
   * gap in the stream, so anything fetched on its own (a turn, the catalog, the dashboard) keys its
   * fetch on this value and asks again when it changes.
   */
  readonly generation: Snapshot<number>
  /** Changes after each debounced refetch that followed `recorded` frames: new usage was written. */
  readonly recorded: Snapshot<number>
  /** The configured budgets, loaded on every `hello` and budget alert; `null` until loaded. */
  readonly budgets: Snapshot<readonly Budget[] | null>
  /** Latest status; `null` before the first `hello`. */
  readonly status: Snapshot<TallyStatusView | null>
  /** Latest balance by route; a route that never succeeded carries its error snapshot or is absent. */
  readonly balances: Snapshot<Readonly<Record<string, BalanceSnapshot>>>
  /** Usage of the current local day; `null` until loaded. */
  readonly today: Snapshot<UsageGroup | null>
  /** Usage of the current local calendar month; `null` until loaded. */
  readonly month: Snapshot<UsageGroup | null>
  /** Spend of each budget over its current period and scope, in the budget's currency, by budget id. */
  readonly budgetSpend: Snapshot<Readonly<Record<string, Money>>>
  /** One session's usage; `null` until loaded. The same instance is returned for the same id. */
  session(sessionId: string): Snapshot<SessionView | null>
  /** Budget alerts not yet shown, oldest first. */
  readonly alerts: Snapshot<readonly BudgetAlert[]>
  dismissAlert(alert: BudgetAlert): void
  /** Asks the Host to query one route's balance now and stores the answer. */
  refreshBalance(route: string): Promise<void>
  /** Reads the budgets (and their spend) again: the settings page calls it after changing one. */
  refreshBudgets(): Promise<void>
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

/** Epoch milliseconds of local midnight on the first day of the month containing `at`, `monthShift` months later. */
function localMonthStart(at: number, zone: string, monthShift: number): number {
  const local = new Date(at + zoneOffset(at, zone))
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + monthShift, 1)
  let guess = wall - zoneOffset(at, zone)
  guess = wall - zoneOffset(guess, zone)
  return guess
}

/** One group summing several (the days of a month): costs add up per currency, never across. */
function sumGroups(groups: readonly UsageGroup[]): UsageGroup {
  const total = emptyGroup()
  const cost = new Map<Currency, string>()
  for (const g of groups) {
    total.tokens.input += g.tokens.input
    total.tokens.cacheRead += g.tokens.cacheRead
    total.tokens.cacheWrite += g.tokens.cacheWrite
    total.tokens.output += g.tokens.output
    total.requestCount += g.requestCount
    total.unpricedCount += g.unpricedCount
    total.unknownUsageCount += g.unknownUsageCount
    for (const m of g.cost) cost.set(m.currency, addDecimal(cost.get(m.currency) ?? '0', m.amount))
  }
  total.cost = [...cost].map(([currency, amount]) => ({ amount, currency }))
  return total
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
  const month = createSnapshot<UsageGroup | null>(null)
  const budgetSpend = createSnapshot<Readonly<Record<string, Money>>>({})
  const alerts = createSnapshot<readonly BudgetAlert[]>([])
  const generation = createSnapshot(0)
  const recorded = createSnapshot(0)
  const budgets = createSnapshot<readonly Budget[] | null>(null)
  const sessions = new Map<string, Writable<SessionView | null>>()
  const sessionSeq = new Map<string, number>()
  /** Sessions whose last subscriber left: kept for identity, never refetched until one returns. */
  const closed = new Set<string>()
  const refs = new Map<string, number>()
  const knownRoutes = new Set<string>()
  let todaySeq = 0
  let monthSeq = 0
  let spendSeq = 0
  let budgetsSeq = 0
  let started = false
  let stopped = false
  let midnight: ReturnType<typeof setTimeout> | undefined

  /** Reloads "today" when the local day ends; every load re-arms it for the day it loaded. */
  function armMidnight(at: number): void {
    clearTimeout(midnight)
    midnight = undefined
    if (stopped) return
    const delay = Math.max(1, localMidnight(at, opts.timeZone, 1) - at)
    midnight = setTimeout(() => {
      midnight = undefined
      fire(loadToday())
      fire(loadMonth())
      fire(loadBudgetSpend())
    }, delay)
  }

  async function loadToday(): Promise<void> {
    const seq = ++todaySeq
    const at = now()
    armMidnight(at)
    const result = await remote.query({
      from: localMidnight(at, opts.timeZone, 0), to: localMidnight(at, opts.timeZone, 1), groupBy: 'day', tz: opts.timeZone,
    })
    if (seq !== todaySeq || !result.ok) return
    today.set(result.value[0] ?? emptyGroup())
  }

  async function loadMonth(): Promise<void> {
    const seq = ++monthSeq
    const at = now()
    const result = await remote.query({
      from: localMonthStart(at, opts.timeZone, 0), to: localMonthStart(at, opts.timeZone, 1), groupBy: 'day', tz: opts.timeZone,
    })
    if (seq !== monthSeq || !result.ok) return
    month.set(sumGroups(result.value))
  }

  /** Spend of every loaded budget over its current period; one query per budget. */
  async function loadBudgetSpend(): Promise<void> {
    const list = budgets.getSnapshot()
    if (list === null) return
    const seq = ++spendSeq
    const at = now()
    const answers = await Promise.all(list.map(async (budget) => {
      const bounds = budget.period === 'day'
        ? { from: localMidnight(at, opts.timeZone, 0), to: localMidnight(at, opts.timeZone, 1) }
        : { from: localMonthStart(at, opts.timeZone, 0), to: localMonthStart(at, opts.timeZone, 1) }
      const filter = budget.scope.workspaceId === undefined ? undefined : { workspaceId: budget.scope.workspaceId }
      const result = await remote.query({ ...bounds, groupBy: 'day', tz: opts.timeZone, ...(filter ? { filter } : {}) })
      return result.ok ? [budget.id, spentIn(sumGroups(result.value), budget.limit.currency)] as const : null
    }))
    if (seq !== spendSeq) return
    const next: Record<string, Money> = {}
    for (const answer of answers) if (answer !== null) next[answer[0]] = answer[1]
    budgetSpend.set(next)
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

  async function loadBudgets(): Promise<void> {
    const seq = ++budgetsSeq
    const result = await remote.budgets()
    if (seq !== budgetsSeq || !result.ok) return
    budgets.set(result.value)
    await loadBudgetSpend()
  }

  /** Adds the routes of a status to the known ones; returns those that were new. */
  function addRoutes(view: TallyStatusView): string[] {
    const added = view.balanceRoutes.filter(route => !knownRoutes.has(route))
    for (const route of added) knownRoutes.add(route)
    return added
  }

  async function loadBalance(route: string): Promise<void> {
    const result = await remote.balance({ route })
    if (result.ok) putBalance(route, result.value)
  }

  /**
   * Runs a background load. A transport rejection keeps the previous value, like a refused call,
   * instead of surfacing as an unhandled rejection.
   */
  function fire(load: Promise<void>): void {
    load.catch(() => {})
  }

  const openSessions = () => [...sessions.keys()].filter(id => !closed.has(id))

  function reloadAll(): void {
    cancelRecorded()
    fire(loadToday())
    fire(loadMonth())
    for (const id of openSessions()) fire(loadSession(id))
    for (const route of [...knownRoutes]) fire(loadBalance(route))
    fire(loadBudgets())
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
    if (refetchToday) {
      fire(loadToday())
      fire(loadMonth())
      fire(loadBudgetSpend())
      recorded.set(recorded.getSnapshot() + 1)
    }
    for (const id of ids) if (sessions.has(id) && !closed.has(id)) fire(loadSession(id))
  }
  function scheduleRecorded(sessionIds: readonly string[]): void {
    dueToday = true
    for (const id of sessionIds) if (sessions.has(id) && !closed.has(id)) dueSessions.add(id)
    clearTimeout(quiet)
    quiet = setTimeout(flushRecorded, RECORDED_DEBOUNCE_MS)
    ceiling ??= setTimeout(flushRecorded, RECORDED_MAX_WAIT_MS)
  }

  function apply(frame: TallyWatchFrame): void {
    switch (frame.type) {
      case 'hello':
        status.set(frame.status)
        addRoutes(frame.status)
        reloadAll()
        generation.set(generation.getSnapshot() + 1)
        break
      case 'status': {
        // A backfill or rebuild writes entries without `recorded` frames: when one ends, the
        // totals are read again and the dashboard is told new usage was written.
        const wasBackfilling = status.getSnapshot()?.usage.backfill != null
        status.set(frame.status)
        if (wasBackfilling && frame.status.usage.backfill === null) {
          fire(loadToday())
          fire(loadMonth())
          fire(loadBudgetSpend())
          recorded.set(recorded.getSnapshot() + 1)
        }
        // A balance provider registered after the `hello` shows up here first.
        for (const route of addRoutes(frame.status)) fire(loadBalance(route))
        break
      }
      case 'recorded':
        scheduleRecorded([frame.entry.sessionId, frame.entry.rootSessionId])
        break
      case 'balance-changed':
        putBalance(frame.snapshot.provider, frame.snapshot)
        break
      case 'budget-crossed': {
        const key = alertKey(frame.alert)
        if (!alerts.getSnapshot().some(a => alertKey(a) === key)) alerts.set([...alerts.getSnapshot(), frame.alert])
        // The alert names its budget by id; a budget added since the last load is fetched now.
        if (!budgets.getSnapshot()?.some(b => b.id === frame.alert.budgetId)) fire(loadBudgets())
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
      if (signal.aborted) stop()
    }
  }

  function stop(): void {
    stopped = true
    cancelRecorded()
    clearTimeout(midnight)
    midnight = undefined
  }

  return {
    start(signal, frames) {
      if (started) throw new Error('the tally store was already started')
      started = true
      if (signal.aborted) { stopped = true; return }
      const source = frames ?? remote.watch(signal)
      signal.addEventListener('abort', stop, { once: true })
      void consume(signal, source)
    },
    generation,
    recorded,
    budgets,
    status,
    balances,
    today,
    month,
    budgetSpend,
    alerts,
    session(sessionId) {
      let snapshot = sessions.get(sessionId)
      if (!snapshot) {
        const inner = createSnapshot<SessionView | null>(null)
        // Subscriptions are reference counted: once the last one leaves, the session is closed and
        // no longer refetched; the next subscriber reopens and reloads it.
        snapshot = {
          ...inner,
          subscribe(listener) {
            const count = refs.get(sessionId) ?? 0
            refs.set(sessionId, count + 1)
            if (count === 0 && closed.delete(sessionId) && started) fire(loadSession(sessionId))
            const off = inner.subscribe(listener)
            let live = true
            return () => {
              if (!live) return
              live = false
              off()
              const left = (refs.get(sessionId) ?? 1) - 1
              refs.set(sessionId, left)
              if (left === 0) {
                closed.add(sessionId)
                dueSessions.delete(sessionId)
              }
            }
          },
        }
        sessions.set(sessionId, snapshot)
        // Before `start` the first `hello` loads it; afterwards it must load itself.
        if (started) fire(loadSession(sessionId))
      }
      return snapshot
    },
    dismissAlert(alert) {
      const key = alertKey(alert)
      alerts.set(alerts.getSnapshot().filter(a => alertKey(a) !== key))
    },
    refreshBudgets: () => loadBudgets(),
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
