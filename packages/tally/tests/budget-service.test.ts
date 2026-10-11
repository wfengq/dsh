import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Budget, BudgetAlert, Currency, TallyEntry, UsageGroup, UsageQuery } from 'dsh-tally-api'
import { BudgetFile } from '../src/budget-file.js'
import { TallyBudget } from '../src/budget-service.js'
import * as tally from '../src/index.js'

const DAY = 24 * 3600_000
const T0 = Date.UTC(2026, 9, 20, 12) // 2026-10-20T12:00Z
const TZ = 'UTC'

/** Stand-in for `ctx.tallyUsage`: `query` answers from `spent`, recording every call. */
class FakeUsage extends Service {
  spent: Partial<Record<Currency, string>> = {}
  queries: UsageQuery[] = []
  fail: Error | undefined
  /** When set, the next query waits for it. */
  gate: Promise<void> | undefined

  constructor(ctx: Context) {
    super(ctx, 'tallyUsage')
  }

  async query(q: UsageQuery): Promise<UsageGroup[]> {
    this.queries.push(q)
    if (this.gate) await this.gate
    if (this.fail) throw this.fail
    // Spread over two groups to prove the service sums them.
    const cost = (Object.entries(this.spent) as [Currency, string][]).map(([currency, amount]) => ({ amount, currency }))
    const empty = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    const group = (key: string, c: typeof cost): UsageGroup => ({
      key, tokens: empty, cost: c, requestCount: 1, unpricedCount: 0, unknownUsageCount: 0,
    })
    return [group('a', cost.map(m => ({ ...m, amount: '0' }))), group('b', cost)]
  }
}

const daily: Budget = { id: 'b1', period: 'day', scope: {}, limit: { amount: '10', currency: 'CNY' } }

let ctx: Context
let fiber: { dispose(): Promise<void> }
let usage: FakeUsage
let dir: string
let path: string
let alerts: BudgetAlert[]

async function load(): Promise<TallyBudget> {
  const loaded = ctx.plugin(TallyBudget, { path, timeZone: TZ })
  fiber = loaded
  await loaded
  return ctx.get('tallyBudget') as unknown as TallyBudget
}

function entry(over: Partial<TallyEntry> = {}): TallyEntry {
  return { at: T0, route: 'r', cost: { amount: '1', currency: 'CNY' }, ...over } as TallyEntry
}

/** Emit a recorded entry, then wait for the evaluation chain to drain. */
async function record(e: TallyEntry = entry()): Promise<void> {
  ctx.emit('tally/recorded', e)
  await idle()
}

const idle = () => new Promise<void>(resolve => setImmediate(resolve))

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-tally-budget-svc-'))
  path = join(dir, 'budgets.json')
  ctx = new Context()
  alerts = []
  ctx.on('tally/budget-crossed', (a) => { alerts.push(a) })
  await ctx.plugin(FakeUsage)
  usage = ctx.get('tallyUsage') as unknown as FakeUsage
})

afterEach(async () => {
  await fiber?.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('TallyBudget', () => {
  it('is exported and the config documents its defaults', () => {
    expect(tally.TallyBudget).toBe(TallyBudget)
    const config = tally.Config({})
    expect(config.budgetPath).toBeUndefined()
    expect(config.timeZone).toBeUndefined()
  })

  it('alerts 0.8 once, then 1 once, while spent grows', async () => {
    const budget = await load()
    budget.set(daily)
    usage.spent = { CNY: '7' }
    await record()
    expect(alerts).toEqual([])
    usage.spent = { CNY: '8' }
    await record()
    expect(alerts).toEqual([{
      budgetId: 'b1',
      threshold: 0.8,
      spent: { amount: '8', currency: 'CNY' },
      limit: { amount: '10', currency: 'CNY' },
      periodStart: Date.UTC(2026, 9, 20),
    }])
    usage.spent = { CNY: '9' }
    await record()
    expect(alerts).toHaveLength(1)
    usage.spent = { CNY: '10' }
    await record()
    expect(alerts.map(a => a.threshold)).toEqual([0.8, 1])
    usage.spent = { CNY: '11' }
    await record()
    expect(alerts).toHaveLength(2)
  })

  it('queries the whole period of the entry in the configured time zone', async () => {
    const budget = await load()
    budget.set(daily)
    await record()
    expect(usage.queries).toEqual([{
      from: Date.UTC(2026, 9, 20),
      to: Date.UTC(2026, 9, 21),
      groupBy: 'day',
      tz: TZ,
    }])
  })

  it('fires 0.8 then 1 when spent jumps over both', async () => {
    const budget = await load()
    budget.set(daily)
    usage.spent = { CNY: '12' }
    await record()
    expect(alerts.map(a => a.threshold)).toEqual([0.8, 1])
    expect(alerts[1]!.spent).toEqual({ amount: '12', currency: 'CNY' })
  })

  it('compares exactly, with no floating point, on 18-decimal amounts', async () => {
    const budget = await load()
    budget.set({ ...daily, limit: { amount: '0.3', currency: 'CNY' } })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    usage.spent = { CNY: '0.239999999999999999' }
    await record()
    expect(usage.queries).toHaveLength(1)
    expect(alerts).toEqual([])
    usage.spent = { CNY: '0.24' }
    await record()
    expect(alerts.map(a => a.threshold)).toEqual([0.8])
    expect(alerts[0]!.spent).toEqual({ amount: '0.24', currency: 'CNY' })
    usage.spent = { CNY: '0.299999999999999999' }
    await record()
    expect(alerts).toHaveLength(1)
    usage.spent = { CNY: '0.3' }
    await record()
    expect(alerts.map(a => a.threshold)).toEqual([0.8, 1])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports the spent amount with full 18-decimal precision', async () => {
    const budget = await load()
    budget.set(daily)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    usage.spent = { CNY: '8.123456789012345678' }
    await record()
    expect(alerts[0]!.spent).toEqual({ amount: '8.123456789012345678', currency: 'CNY' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('skips a budget removed while its query was running', async () => {
    const budget = await load()
    budget.set(daily)
    let release!: () => void
    usage.gate = new Promise<void>(resolve => { release = resolve })
    usage.spent = { CNY: '12' }
    ctx.emit('tally/recorded', entry())
    await idle()
    budget.remove('b1')
    release()
    await idle()
    expect(alerts).toEqual([])
    expect(BudgetFile.load(path).fired('b1', Date.UTC(2026, 9, 20))).toEqual([])
  })

  it('uses the limit current after the query when a budget was replaced meanwhile', async () => {
    const budget = await load()
    budget.set(daily)
    let release!: () => void
    usage.gate = new Promise<void>(resolve => { release = resolve })
    usage.spent = { CNY: '8' }
    ctx.emit('tally/recorded', entry())
    await idle()
    budget.set({ ...daily, limit: { amount: '100', currency: 'CNY' } })
    release()
    await idle()
    expect(alerts).toEqual([])
    // Replaced with a lower limit while a query is running: alerts carry the new limit.
    usage.gate = new Promise<void>(resolve => { release = resolve })
    ctx.emit('tally/recorded', entry())
    await idle()
    budget.set({ ...daily, limit: { amount: '9', currency: 'CNY' } })
    release()
    await idle()
    expect(alerts.map(a => [a.threshold, a.limit.amount])).toEqual([[0.8, '9']])
  })

  it('skips a budget whose period or scope changed while its query was running', async () => {
    const budget = await load()
    budget.set(daily)
    let release!: () => void
    usage.gate = new Promise<void>(resolve => { release = resolve })
    usage.spent = { CNY: '12' }
    ctx.emit('tally/recorded', entry())
    await idle()
    budget.set({ ...daily, period: 'month' })
    release()
    await idle()
    expect(alerts).toEqual([])
  })

  it('ignores an entry from an earlier period than the one already alerted', async () => {
    const budget = await load()
    budget.set(daily)
    usage.spent = { CNY: '8' }
    await record(entry({ at: T0 + DAY }))
    expect(alerts.map(a => a.periodStart)).toEqual([Date.UTC(2026, 9, 21)])
    usage.queries.length = 0
    usage.spent = { CNY: '12' }
    await record(entry({ at: T0 })) // earlier period P1
    expect(alerts).toHaveLength(1)
    expect(usage.queries).toEqual([])
    expect(BudgetFile.load(path).fired('b1', Date.UTC(2026, 9, 21))).toEqual([0.8])
    await record(entry({ at: T0 + DAY }))
    expect(alerts.map(a => [a.periodStart, a.threshold])).toEqual([
      [Date.UTC(2026, 9, 21), 0.8],
      [Date.UTC(2026, 9, 21), 1],
    ])
  })

  it('does not repeat an alert after the service is rebuilt from the file', async () => {
    let budget = await load()
    budget.set(daily)
    usage.spent = { CNY: '8' }
    await record()
    expect(alerts).toHaveLength(1)
    await fiber.dispose()
    budget = await load()
    expect(budget.list()).toEqual([daily])
    usage.spent = { CNY: '9' }
    await record()
    expect(alerts).toHaveLength(1)
    usage.spent = { CNY: '10' }
    await record()
    expect(alerts.map(a => a.threshold)).toEqual([0.8, 1])
  })

  it('alerts each threshold at most once when five entries arrive at the same time', async () => {
    const budget = await load()
    budget.set(daily)
    usage.spent = { CNY: '12' }
    for (let i = 0; i < 5; i++) ctx.emit('tally/recorded', entry())
    await idle()
    await idle()
    expect(alerts.map(a => a.threshold)).toEqual([0.8, 1])
  })

  it('evaluates a burst of entries with a single period query', async () => {
    const budget = await load()
    budget.set(daily)
    usage.spent = { CNY: '12' }
    for (let i = 0; i < 50; i++) ctx.emit('tally/recorded', entry({ at: T0 + i }))
    await idle()
    await idle()
    expect(usage.queries).toHaveLength(1)
    expect(alerts.map(a => [a.threshold, a.spent])).toEqual([
      [0.8, { amount: '12', currency: 'CNY' }],
      [1, { amount: '12', currency: 'CNY' }],
    ])
  })

  it('coalesces entries queued behind a running evaluation, then evaluates them once', async () => {
    const budget = await load()
    budget.set(daily)
    let release!: () => void
    usage.gate = new Promise<void>(resolve => { release = resolve })
    usage.spent = { CNY: '7' }
    ctx.emit('tally/recorded', entry())
    await idle()
    expect(usage.queries).toHaveLength(1) // the first evaluation is running, blocked on its query
    for (let i = 0; i < 5; i++) ctx.emit('tally/recorded', entry())
    usage.gate = undefined
    usage.spent = { CNY: '12' }
    release()
    await idle()
    await idle()
    // One query for the first entry, one for the five that queued up behind it.
    expect(usage.queries).toHaveLength(2)
    expect(alerts.map(a => a.threshold)).toEqual([0.8, 1])
  })

  it('evaluates the older period of a burst first, whatever order its entries arrived in', async () => {
    const budget = await load()
    budget.set(daily)
    usage.spent = { CNY: '8' }
    ctx.emit('tally/recorded', entry({ at: T0 }))
    ctx.emit('tally/recorded', entry({ at: T0 + DAY }))
    ctx.emit('tally/recorded', entry({ at: T0 + 1 }))
    await idle()
    await idle()
    // Evaluating the newer period first would record its alert and make the older one look stale.
    expect(alerts.map(a => [a.periodStart, a.threshold])).toEqual([
      [Date.UTC(2026, 9, 20), 0.8],
      [Date.UTC(2026, 9, 21), 0.8],
    ])
  })

  it('keeps evaluating the rest of a burst when one evaluation fails', async () => {
    const budget = await load()
    budget.set(daily)
    usage.spent = { CNY: '8' }
    const query = usage.query.bind(usage)
    vi.spyOn(usage, 'query')
      .mockImplementationOnce(async () => { throw new Error('boom') })
      .mockImplementation(query)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.emit('tally/recorded', entry({ at: T0 }))
    ctx.emit('tally/recorded', entry({ at: T0 + DAY }))
    await idle()
    await idle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
    expect(alerts.map(a => [a.periodStart, a.threshold])).toEqual([[Date.UTC(2026, 9, 21), 0.8]])
  })

  it('evaluates each period of a burst once, oldest period first', async () => {
    const budget = await load()
    budget.set(daily)
    usage.spent = { CNY: '8' }
    ctx.emit('tally/recorded', entry({ at: T0 }))
    ctx.emit('tally/recorded', entry({ at: T0 + DAY }))
    ctx.emit('tally/recorded', entry({ at: T0 + 1 }))
    ctx.emit('tally/recorded', entry({ at: T0 + DAY + 1 }))
    await idle()
    await idle()
    expect(usage.queries.map(q => q.from)).toEqual([Date.UTC(2026, 9, 20), Date.UTC(2026, 9, 21)])
    expect(alerts.map(a => [a.periodStart, a.threshold])).toEqual([
      [Date.UTC(2026, 9, 20), 0.8],
      [Date.UTC(2026, 9, 21), 0.8],
    ])
  })

  it('does not count entries that match no budget when coalescing', async () => {
    const budget = await load()
    budget.set({ ...daily, scope: { workspaceId: 'w1' } })
    usage.spent = { CNY: '12' }
    ctx.emit('tally/recorded', entry({ workspaceId: 'w2' }))
    ctx.emit('tally/recorded', entry({ workspaceId: 'w1' }))
    ctx.emit('tally/recorded', entry({ workspaceId: 'w2' }))
    await idle()
    await idle()
    expect(usage.queries).toHaveLength(1)
    expect(alerts.map(a => a.threshold)).toEqual([0.8, 1])
  })

  it('evaluates entries one after another, never two evaluations at once', async () => {
    const budget = await load()
    budget.set(daily)
    let release!: () => void
    usage.gate = new Promise<void>(resolve => { release = resolve })
    usage.spent = { CNY: '9' }
    ctx.emit('tally/recorded', entry())
    await idle()
    ctx.emit('tally/recorded', entry())
    await idle()
    expect(usage.queries).toHaveLength(1)
    release()
    await idle()
    await idle()
    expect(usage.queries).toHaveLength(2)
    expect(alerts.map(a => a.threshold)).toEqual([0.8])
  })

  it('ignores entries of another workspace for a scoped budget', async () => {
    const budget = await load()
    budget.set({ ...daily, scope: { workspaceId: 'w1' } })
    usage.spent = { CNY: '12' }
    await record(entry({ workspaceId: 'w2' }))
    await record(entry())
    expect(alerts).toEqual([])
    expect(usage.queries).toEqual([])
    await record(entry({ workspaceId: 'w1' }))
    expect(alerts.map(a => a.threshold)).toEqual([0.8, 1])
    expect(usage.queries[0]!.filter).toEqual({ workspaceId: 'w1' })
  })

  it('only counts the currency of the budget', async () => {
    const budget = await load()
    budget.set({ ...daily, limit: { amount: '10', currency: 'USD' } })
    usage.spent = { CNY: '12', USD: '1' }
    await record(entry({ cost: { amount: '1', currency: 'CNY' } }))
    expect(alerts).toEqual([])
    expect(usage.queries).toEqual([])
    await record(entry({ cost: { amount: '1', currency: 'USD' } }))
    expect(alerts).toEqual([])
    expect(usage.queries).toHaveLength(1)
    usage.spent = { CNY: '100', USD: '9' }
    await record(entry({ cost: { amount: '1', currency: 'USD' } }))
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.spent).toEqual({ amount: '9', currency: 'USD' })
  })

  it('starts over in the next period', async () => {
    const budget = await load()
    budget.set(daily)
    usage.spent = { CNY: '10' }
    await record()
    expect(alerts.map(a => a.threshold)).toEqual([0.8, 1])
    usage.spent = { CNY: '8' }
    await record(entry({ at: T0 + DAY }))
    expect(alerts.map(a => a.threshold)).toEqual([0.8, 1, 0.8])
    expect(alerts[2]!.periodStart).toBe(Date.UTC(2026, 9, 21))
  })

  it('supports monthly budgets', async () => {
    const budget = await load()
    budget.set({ ...daily, period: 'month' })
    usage.spent = { CNY: '8' }
    await record()
    expect(usage.queries[0]).toMatchObject({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1) })
    expect(alerts[0]!.periodStart).toBe(Date.UTC(2026, 9, 1))
  })

  it('does not query for an entry without a cost', async () => {
    const budget = await load()
    budget.set(daily)
    await record(entry({ cost: null }))
    expect(usage.queries).toEqual([])
  })

  it('does nothing without budgets', async () => {
    await load()
    await record()
    expect(usage.queries).toEqual([])
  })

  it('evaluates every budget independently', async () => {
    const budget = await load()
    budget.set(daily)
    budget.set({ id: 'b2', period: 'day', scope: {}, limit: { amount: '12', currency: 'CNY' } })
    usage.spent = { CNY: '10' }
    await record()
    expect(alerts.map(a => [a.budgetId, a.threshold])).toEqual([['b1', 0.8], ['b1', 1], ['b2', 0.8]])
  })

  it('logs a failing evaluation and keeps evaluating later entries', async () => {
    const budget = await load()
    budget.set(daily)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    usage.fail = new Error('db down')
    await record()
    expect(alerts).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'))
    usage.fail = undefined
    usage.spent = { CNY: '8' }
    await record()
    expect(alerts.map(a => a.threshold)).toEqual([0.8])
  })

  it('keeps going when an alert listener throws, and does not alert twice', async () => {
    const budget = await load()
    budget.set(daily)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const off = ctx.on('tally/budget-crossed', () => { throw new Error('listener boom') })
    usage.spent = { CNY: '12' }
    await record()
    off()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener boom'))
    expect(alerts.map(a => a.threshold)).toEqual([0.8, 1])
    await record()
    expect(alerts).toHaveLength(2)
  })

  it('stops evaluating once disposed', async () => {
    const budget = await load()
    budget.set(daily)
    await fiber.dispose()
    usage.spent = { CNY: '12' }
    await record()
    expect(usage.queries).toEqual([])
    expect(alerts).toEqual([])
    void budget
  })

  describe('set, list, remove, status', () => {
    it('persists budgets and returns copies from list', async () => {
      const budget = await load()
      budget.set(daily)
      const list = budget.list()
      list[0]!.limit.amount = '1'
      list.pop()
      expect(budget.list()).toEqual([daily])
      expect(JSON.parse(readFileSync(path, 'utf8')).budgets).toEqual([daily])
    })

    it('replaces a budget with the same id', async () => {
      const budget = await load()
      budget.set(daily)
      budget.set({ ...daily, limit: { amount: '20', currency: 'CNY' } })
      expect(budget.list()).toEqual([{ ...daily, limit: { amount: '20', currency: 'CNY' } }])
    })

    it('throws on an invalid budget and leaves the file untouched', async () => {
      const budget = await load()
      budget.set(daily)
      const before = readFileSync(path, 'utf8')
      expect(() => budget.set({ ...daily, limit: { amount: '0', currency: 'CNY' } })).toThrow(/^tally: invalid budget: .*limit\.amount/)
      expect(() => budget.set({ ...daily, id: '', period: 'week' } as unknown as Budget)).toThrow(/id must be.*; period must be/)
      expect(readFileSync(path, 'utf8')).toBe(before)
      expect(budget.list()).toEqual([daily])
    })

    it('does not create the file for an invalid first budget', async () => {
      const budget = await load()
      expect(() => budget.set({} as Budget)).toThrow('tally: invalid budget: ')
      expect(() => readFileSync(path)).toThrow()
    })

    it('removes budgets, ignoring unknown ids', async () => {
      const budget = await load()
      budget.set(daily)
      budget.remove('nope')
      expect(budget.list()).toHaveLength(1)
      budget.remove('b1')
      expect(budget.list()).toEqual([])
      expect(BudgetFile.load(path).budgets()).toEqual([])
    })

    it('a removed budget no longer alerts, and re-adding it starts fresh', async () => {
      const budget = await load()
      budget.set(daily)
      usage.spent = { CNY: '8' }
      await record()
      budget.remove('b1')
      budget.set(daily)
      await record()
      expect(alerts.map(a => a.threshold)).toEqual([0.8, 0.8])
    })

    it('reports no errors by default and the load error of a corrupt file', async () => {
      let budget = await load()
      expect(budget.status()).toEqual({ errors: [] })
      await fiber.dispose()
      const fs = await import('node:fs')
      fs.writeFileSync(path, '{ nope')
      budget = await load()
      const { errors } = budget.status()
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatch(/budget/i)
      expect(budget.list()).toEqual([])
    })
  })
})
