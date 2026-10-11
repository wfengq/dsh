import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BalanceSnapshot, BudgetAlert, SessionView, TallyEntry, TallyStatusView, TallyWatchFrame, UsageGroup } from 'dsh-tally-api'
import { createTallyStore, type TallyRemoteFace } from '../src/client/store.ts'

const ok = <T>(value: T) => ({ ok: true as const, value })
const fail = (message: string) => ({ ok: false as const, error: new Error(message) })

const status = (catalogVersion = 'v1', balanceRoutes: string[] = []): TallyStatusView => ({
  usage: { backfill: null, errors: [] }, catalogVersion, pricingErrors: [], budgetErrors: [], balanceRoutes,
})
const group = (amount: string): UsageGroup => ({
  key: 'day', tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, cost: [{ amount, currency: 'CNY' }],
  requestCount: 1, unpricedCount: 0, unknownUsageCount: 0,
})
const sessionView = (amount: string): SessionView => ({
  usage: { sessionId: 's1', total: group(amount), children: [] }, lastRoute: 'r', lastModel: 'm',
})
const balance = (amount: string, extra: Partial<BalanceSnapshot> = {}): BalanceSnapshot => ({
  provider: 'p', wallets: [{ kind: 'total', money: { amount, currency: 'CNY' } }], fetchedAt: 1, stale: false, ...extra,
})
const entry = (sessionId = 's1', rootSessionId = sessionId): TallyEntry => ({
  id: 'e', sessionId, rootSessionId, at: 1, route: 'r', provider: 'p', model: 'm', band: null,
  tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, cost: null, priceVersion: null, usageKnown: true,
})
const alert = (budgetId = 'b'): BudgetAlert => ({
  budgetId, threshold: 0.8, spent: { amount: '8', currency: 'CNY' }, limit: { amount: '10', currency: 'CNY' }, periodStart: 0,
})

/** An async queue the test pushes frames into. */
function frameQueue() {
  const buffer: TallyWatchFrame[] = []
  let wake: (() => void) | undefined
  let closed = false
  return {
    push(frame: TallyWatchFrame) { buffer.push(frame); wake?.() },
    close() { closed = true; wake?.() },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (buffer.length > 0) yield buffer.shift()!
          else if (closed) return
          else await new Promise<void>(resolve => { wake = resolve })
        }
      },
    } as AsyncIterable<TallyWatchFrame>,
  }
}

async function flush() {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
}

describe('createTallyStore', () => {
  let queue: ReturnType<typeof frameQueue>
  let controller: AbortController
  let todayAmount: string
  const api = {
    status: vi.fn(),
    query: vi.fn(),
    session: vi.fn(),
    balance: vi.fn(),
    refreshBalance: vi.fn(),
    watch: vi.fn(),
  }
  let face: TallyRemoteFace

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 9, 11, 3, 0, 0))
    queue = frameQueue()
    controller = new AbortController()
    todayAmount = '1'
    for (const fn of Object.values(api)) fn.mockReset()
    api.status.mockImplementation(async () => ok(status()))
    api.query.mockImplementation(async () => ok([group(todayAmount)]))
    api.session.mockImplementation(async () => ok(sessionView('3')))
    api.balance.mockImplementation(async () => ok(balance('50')))
    api.watch.mockImplementation(() => queue.iterable)
    // `@deepseek-ai/dsh-client-test-runtime@0.2.0-rc.2` cannot be imported outside the dsh repo (its entry
    // imports unshipped renderer sources), so `ctx.remote.tally` is scripted as a plain object.
    face = api as unknown as TallyRemoteFace
  })

  afterEach(() => {
    controller.abort()
    queue.close()
    vi.useRealTimers()
  })

  const make = () => createTallyStore(face, { timeZone: 'Asia/Shanghai' })

  it('fetches today once after hello, over the local day in the configured time zone', async () => {
    const store = make()
    store.start(controller.signal)
    expect(store.today.getSnapshot()).toBeNull()
    queue.push({ type: 'hello', status: status('v7') })
    await flush()
    expect(api.query).toHaveBeenCalledTimes(1)
    const request = api.query.mock.calls[0]![0]
    // 2026-10-11 11:00 in Shanghai: the day is [10-11 00:00, 10-12 00:00) +08:00.
    expect(request.from).toBe(Date.UTC(2026, 9, 10, 16))
    expect(request.to).toBe(Date.UTC(2026, 9, 11, 16))
    expect(request.groupBy).toBe('day')
    expect(request.tz).toBe('Asia/Shanghai')
    expect(store.today.getSnapshot()?.cost).toEqual([{ amount: '1', currency: 'CNY' }])
    expect(store.status.getSnapshot()?.catalogVersion).toBe('v7')
  })

  it('updates the status snapshot on every status frame', async () => {
    const store = make()
    store.start(controller.signal)
    queue.push({ type: 'hello', status: status('v1') })
    queue.push({ type: 'status', status: status('v2') })
    await flush()
    expect(store.status.getSnapshot()?.catalogVersion).toBe('v2')
  })

  it('notifies subscribers and stops after unsubscribe', async () => {
    const store = make()
    const listener = vi.fn()
    const off = store.status.subscribe(listener)
    store.start(controller.signal)
    queue.push({ type: 'hello', status: status() })
    await flush()
    expect(listener).toHaveBeenCalled()
    const calls = listener.mock.calls.length
    off()
    queue.push({ type: 'status', status: status('v9') })
    await flush()
    expect(listener).toHaveBeenCalledTimes(calls)
  })

  it('refetches today and the loaded session once for five recorded frames within 600 ms', async () => {
    const store = make()
    const session = store.session('s1')
    store.start(controller.signal)
    queue.push({ type: 'hello', status: status() })
    await flush()
    expect(session.getSnapshot()?.usage.total.cost[0]?.amount).toBe('3')
    api.query.mockClear()
    api.session.mockClear()
    todayAmount = '2'
    for (let i = 0; i < 5; i++) {
      queue.push({ type: 'recorded', entry: entry('s1') })
      await vi.advanceTimersByTimeAsync(120)
    }
    expect(api.query).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    expect(api.query).toHaveBeenCalledTimes(1)
    expect(api.session).toHaveBeenCalledTimes(1)
    expect(store.today.getSnapshot()?.cost[0]?.amount).toBe('2')
  })

  it('does not refetch sessions that were never loaded', async () => {
    const store = make()
    store.start(controller.signal)
    queue.push({ type: 'hello', status: status() })
    await flush()
    api.session.mockClear()
    queue.push({ type: 'recorded', entry: entry('other') })
    await vi.advanceTimersByTimeAsync(600)
    expect(api.session).not.toHaveBeenCalled()
  })

  it('refetches everything on a fresh hello and shows the server value, never a sum', async () => {
    const store = make()
    store.session('s1')
    store.start(controller.signal)
    api.status.mockImplementation(async () => ok(status('v1', ['r1'])))
    queue.push({ type: 'hello', status: status('v1', ['r1']) })
    await flush()
    expect(store.today.getSnapshot()?.cost[0]?.amount).toBe('1')
    expect(store.balances.getSnapshot().r1?.wallets[0]?.money.amount).toBe('50')

    // The connection drops; the pending recorded delta must not be applied on top of the reload.
    queue.push({ type: 'recorded', entry: entry('s1') })
    todayAmount = '5'
    api.balance.mockImplementation(async () => ok(balance('45')))
    api.query.mockClear()
    api.session.mockClear()
    queue.push({ type: 'hello', status: status('v2', ['r1']) })
    await flush()
    await vi.advanceTimersByTimeAsync(600)
    await flush()
    expect(api.query).toHaveBeenCalledTimes(1)
    expect(api.session).toHaveBeenCalledTimes(1)
    expect(store.today.getSnapshot()?.cost[0]?.amount).toBe('5')
    expect(store.balances.getSnapshot().r1?.wallets[0]?.money.amount).toBe('45')
  })

  it('keeps the previous value when a refetch fails', async () => {
    const store = make()
    store.start(controller.signal)
    queue.push({ type: 'hello', status: status() })
    await flush()
    api.query.mockImplementation(async () => fail('boom'))
    queue.push({ type: 'hello', status: status() })
    await flush()
    expect(store.today.getSnapshot()?.cost[0]?.amount).toBe('1')
  })

  it('replaces a route balance on balance-changed', async () => {
    const store = make()
    store.start(controller.signal)
    queue.push({ type: 'hello', status: status() })
    queue.push({ type: 'balance-changed', snapshot: balance('9', { provider: 'p' }) })
    await flush()
    // Frames carry no route; the snapshot is keyed by its provider.
    expect(store.balances.getSnapshot().p?.wallets[0]?.money.amount).toBe('9')
    queue.push({ type: 'balance-changed', snapshot: balance('8', { stale: true, errorCode: 'failed', error: 'x' }) })
    await flush()
    expect(store.balances.getSnapshot().p?.wallets[0]?.money.amount).toBe('8')
    expect(store.balances.getSnapshot().p?.stale).toBe(true)
  })

  it('queues budget alerts, keeps them across hello, and removes a dismissed one', async () => {
    const store = make()
    store.start(controller.signal)
    queue.push({ type: 'hello', status: status() })
    const first = alert('a')
    queue.push({ type: 'budget-crossed', alert: first })
    queue.push({ type: 'budget-crossed', alert: alert('b') })
    await flush()
    expect(store.alerts.getSnapshot().map(a => a.budgetId)).toEqual(['a', 'b'])
    queue.push({ type: 'hello', status: status() })
    await flush()
    expect(store.alerts.getSnapshot()).toHaveLength(2)
    store.dismissAlert(first)
    expect(store.alerts.getSnapshot().map(a => a.budgetId)).toEqual(['b'])
  })

  it('stops consuming when the signal aborts', async () => {
    const store = make()
    store.start(controller.signal)
    queue.push({ type: 'hello', status: status() })
    await flush()
    controller.abort()
    api.query.mockClear()
    queue.push({ type: 'hello', status: status() })
    await flush()
    expect(api.query).not.toHaveBeenCalled()
  })
})
