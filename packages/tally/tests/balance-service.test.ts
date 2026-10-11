import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { BalanceSnapshot, TallyEntry, Wallet } from 'dsh-tally-api'
import { TallyBalance } from '../src/balance-service.js'
import * as tally from '../src/index.js'

const CNY_86: Wallet[] = [{ kind: 'total', money: { amount: '86.2', currency: 'CNY' } }]
const CNY_80: Wallet[] = [{ kind: 'total', money: { amount: '80', currency: 'CNY' } }]

const CONFIG = { debounceMs: 3000, minIntervalMs: 60000, timeoutMs: 10000 }

let ctx: Context
let fiber: { dispose(): Promise<void> }
let changes: BalanceSnapshot[]

async function load(config = CONFIG): Promise<TallyBalance> {
  const loaded = ctx.plugin(TallyBalance, config)
  fiber = loaded
  await loaded
  return ctx.get('tallyBalance') as unknown as TallyBalance
}

function recorded(route: string): void {
  ctx.emit('tally/recorded', { route } as TallyEntry)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'))
  ctx = new Context()
  changes = []
  ctx.on('tally/balance-changed', (snap) => { changes.push(snap) })
})

afterEach(async () => {
  await fiber?.dispose()
  vi.useRealTimers()
})

describe('TallyBalance', () => {
  it('is mounted by the dsh-tally plugin with the documented defaults', () => {
    const config = tally.Config({})
    expect(config.balanceDebounceMs).toBe(3000)
    expect(config.balanceMinIntervalMs).toBe(60000)
    expect(config.balanceTimeoutMs).toBe(10000)
    expect(tally.TallyBalance).toBe(TallyBalance)
  })

  it('returns null without a fetcher', async () => {
    const balance = await load()
    expect(await balance.get('r')).toBeNull()
    expect(await balance.refresh('r')).toBeNull()
  })

  it('refreshes into a fresh snapshot and announces it once', async () => {
    const balance = await load()
    balance.register('r', async () => CNY_86)
    const snap = await balance.refresh('r')
    expect(snap).toEqual({ provider: 'r', wallets: CNY_86, fetchedAt: Date.now(), stale: false })
    expect(changes).toEqual([snap])
    // Same wallets again: no new announcement.
    await balance.refresh('r')
    expect(changes).toHaveLength(1)
    // Cached.
    expect(await balance.get('r')).toMatchObject({ wallets: CNY_86, stale: false })
  })

  it('announces again when the wallets differ', async () => {
    const balance = await load()
    let next = CNY_86
    balance.register('r', async () => next)
    await balance.refresh('r')
    next = CNY_80
    await balance.refresh('r')
    expect(changes.map(c => c.wallets)).toEqual([CNY_86, CNY_80])
  })

  it('get fetches when nothing is cached', async () => {
    const balance = await load()
    const fetcher = vi.fn(async () => CNY_86)
    balance.register('r', fetcher)
    expect(await balance.get('r')).toMatchObject({ wallets: CNY_86 })
    await balance.get('r')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight request between concurrent refreshes', async () => {
    const balance = await load()
    let release!: (w: Wallet[]) => void
    const fetcher = vi.fn(() => new Promise<Wallet[]>((resolve) => { release = resolve }))
    balance.register('r', fetcher)
    const a = balance.refresh('r')
    const b = balance.refresh('r')
    release(CNY_86)
    const [x, y] = await Promise.all([a, b])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(x).toBe(y)
    expect(x!.wallets).toEqual(CNY_86)
    // Once settled, a refresh fetches again.
    const again = balance.refresh('r')
    release(CNY_80)
    expect((await again)!.wallets).toEqual(CNY_80)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous wallets and marks the snapshot stale on failure', async () => {
    const balance = await load()
    let fail = false
    balance.register('r', async () => {
      if (fail) throw new Error('HTTP 503')
      return CNY_86
    })
    const ok = await balance.refresh('r')
    vi.setSystemTime(Date.now() + 1000)
    fail = true
    const snap = await balance.refresh('r')
    expect(snap).toEqual({ ...ok, stale: true, error: 'HTTP 503' })
    expect(await balance.get('r')).toEqual(snap)
    expect(changes).toHaveLength(2)
    expect(changes[1]).toEqual(snap)
    // Recovery announces even with identical wallets, because the last snapshot was stale.
    fail = false
    const back = await balance.refresh('r')
    expect(back).toMatchObject({ wallets: CNY_86, stale: false })
    expect(back).not.toHaveProperty('error')
    expect(changes).toHaveLength(3)
  })

  it('never reports zero: a never-successful route fails with no wallets', async () => {
    const balance = await load()
    balance.register('r', async () => { throw new Error('HTTP 401') })
    const snap = await balance.refresh('r')
    expect(snap).toEqual({ provider: 'r', wallets: [], fetchedAt: Date.now(), stale: true, error: 'HTTP 401' })
    expect(changes).toEqual([snap])
  })

  it('reports a synchronous throw and a non-Error rejection', async () => {
    const balance = await load()
    balance.register('a', () => { throw new Error('boom') })
    balance.register('b', () => Promise.reject('plain'))
    expect(await balance.refresh('a')).toMatchObject({ stale: true, error: 'boom' })
    expect(await balance.refresh('b')).toMatchObject({ stale: true, error: 'plain' })
  })

  it('rejects a duplicate registration and forgets everything on dispose', async () => {
    const balance = await load()
    const dispose = balance.register('r', async () => CNY_86)
    expect(() => balance.register('r', async () => CNY_80))
      .toThrow('tally: balance provider already registered: r')
    await balance.refresh('r')
    dispose()
    expect(await balance.get('r')).toBeNull()
    expect(await balance.refresh('r')).toBeNull()
    // The route can be registered again, with a clean cache.
    balance.register('r', async () => CNY_80)
    expect(await balance.get('r')).toMatchObject({ wallets: CNY_80 })
  })

  it('aborts the in-flight request and drops its result when the route is disposed', async () => {
    const balance = await load()
    let signal!: AbortSignal
    const dispose = balance.register('r', (s) => { signal = s; return new Promise<Wallet[]>(() => {}) })
    const pending = balance.refresh('r')
    dispose()
    expect(signal.aborted).toBe(true)
    await pending
    expect(await balance.get('r')).toBeNull()
    expect(changes).toEqual([])
  })

  describe('auto refresh', () => {
    it('debounces by debounceMs and spaces automatic refreshes by minIntervalMs', async () => {
      const balance = await load()
      const fetcher = vi.fn(async () => CNY_86)
      balance.register('r', fetcher)

      recorded('r')
      await vi.advanceTimersByTimeAsync(2999)
      expect(fetcher).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(fetcher).toHaveBeenCalledTimes(1)

      // Debounce fires at 13s, but the last automatic start was at 3s: deferred to 63s.
      await vi.advanceTimersByTimeAsync(7000)
      recorded('r')
      await vi.advanceTimersByTimeAsync(3000)
      expect(fetcher).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(49999)
      expect(fetcher).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('refreshes within minIntervalMs of the first trigger even if entries never pause', async () => {
      const balance = await load()
      const fetcher = vi.fn(async () => CNY_86)
      balance.register('r', fetcher)
      for (let t = 0; t <= 58000; t += 2000) {
        recorded('r')
        if (t < 58000) await vi.advanceTimersByTimeAsync(2000)
      }
      // The last entry arrived at 58s; the cap lands the refresh at 60s, not 61s.
      await vi.advanceTimersByTimeAsync(1999)
      expect(fetcher).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('does not move a min-interval deferral when more entries arrive during it', async () => {
      const balance = await load()
      const fetcher = vi.fn(async () => CNY_86)
      balance.register('r', fetcher)
      const start = Date.now()
      recorded('r')
      await vi.advanceTimersByTimeAsync(3000)
      expect(fetcher).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(7000)
      recorded('r') // debounce fires at 13s and defers to 63s
      await vi.advanceTimersByTimeAsync(3000)
      for (const at of [20000, 40000, 62000]) {
        await vi.advanceTimersByTimeAsync(start + at - Date.now())
        recorded('r')
      }
      await vi.advanceTimersByTimeAsync(999)
      expect(fetcher).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('collapses a burst of entries into one refresh', async () => {
      const balance = await load()
      const fetcher = vi.fn(async () => CNY_86)
      balance.register('r', fetcher)
      recorded('r')
      await vi.advanceTimersByTimeAsync(1000)
      recorded('r')
      await vi.advanceTimersByTimeAsync(2999)
      expect(fetcher).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('ignores routes without a fetcher and manual refreshes do not count towards the interval', async () => {
      const balance = await load()
      const fetcher = vi.fn(async () => CNY_86)
      recorded('other')
      balance.register('r', fetcher)
      await balance.refresh('r')
      expect(fetcher).toHaveBeenCalledTimes(1)
      recorded('r')
      await vi.advanceTimersByTimeAsync(3000)
      expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('is cancelled when the route is disposed', async () => {
      const balance = await load()
      const fetcher = vi.fn(async () => CNY_86)
      const dispose = balance.register('r', fetcher)
      recorded('r')
      dispose()
      await vi.advanceTimersByTimeAsync(60000)
      expect(fetcher).not.toHaveBeenCalled()
    })
  })

  it('aborts a request that exceeds timeoutMs and reports it stale', async () => {
    const balance = await load()
    let signal!: AbortSignal
    balance.register('r', (s) => { signal = s; return new Promise<Wallet[]>(() => {}) })
    const pending = balance.refresh('r')
    await vi.advanceTimersByTimeAsync(9999)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signal.aborted).toBe(true)
    const snap = await pending
    expect(snap).toMatchObject({ provider: 'r', wallets: [], stale: true })
    expect(snap!.error).toEqual(expect.any(String))
  })

  it('aborts in-flight requests and clears timers when the service is disposed', async () => {
    const balance = await load()
    let signal!: AbortSignal
    const slow = vi.fn((s: AbortSignal) => { signal = s; return new Promise<Wallet[]>(() => {}) })
    balance.register('r', slow)
    const quiet = vi.fn(async () => CNY_86)
    balance.register('q', quiet)
    const pending = balance.refresh('r')
    recorded('q')
    await fiber.dispose()
    expect(signal.aborted).toBe(true)
    await pending
    await vi.advanceTimersByTimeAsync(60000)
    expect(quiet).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
