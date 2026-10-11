import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  BalanceSnapshot, BandView, Budget, CatalogView, PeakSavings, SessionView, TurnUsage, UsageGroup,
} from 'dsh-tally-api'
import * as tally from '../src/index.js'
import { schemas, TALLY_REMOTE } from '../src/remote/contract.js'
import { header, message, seqd, stepEnd, stepStart, T0, turnEnd, turnStart, U1, U2 } from './fixtures/events.ts'

/** Minimal stand-in for the official `sessionQuery` service: no sessions on disk. */
class EmptySessionQuery extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionQuery')
  }

  async listSessions() {
    return []
  }

  async readSession(id: string): Promise<never> {
    throw new Error('not found: ' + id)
  }
}

const DAY = 86_400_000
const sh = (iso: string) => Date.parse(iso + '+08:00')

const turn = (n: number, usage = U1, route = 'deepseek-official', model = 'deepseek-flash') => [
  turnStart(n), header(route, model), stepStart(n, 1), message(n, 1, usage, { provider: route, model }), stepEnd(n, 1),
  turnEnd(n),
]

/** Shifts the fixture clock (T0 + index * 1000) so the events start at `base`. */
const shifted = (events: SessionEvent[], base: number): SessionEvent[] =>
  events.map(e => ({ ...e, time: e.time - T0 + base }) as SessionEvent)

let dir: string
let ctx: Context
let fiber: { dispose(): Promise<void> }

function budgetFile(): string {
  return readFileSync(join(dir, 'budgets.json'), 'utf8')
}

async function start(config: Partial<tally.Config> = {}): Promise<void> {
  ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService, {})
  await ctx.plugin(EmptySessionQuery)
  const loading = ctx.plugin(tally, { dbPath: join(dir, 'tally.v1.sqlite'), budgetPath: join(dir, 'budgets.json'), ...config })
  fiber = loading
  await loading
  // Sub-services start once their injections are available, after the plugin itself resolved.
  await new Promise<void>(resolve => ctx.inject(['tallyRemote'], () => resolve()))
}

/** Writes a session into the ledger through the live path. */
function record(id: string, events: SessionEvent[], cwd = '/work'): void {
  const all = events
  let visible = 0
  const fake = {
    id,
    header: { id, createdAt: 0, cwd },
    inheritedEventCount: 0,
    isOwnSeq: () => true,
    ownEvents: () => all.slice(0, visible),
  }
  for (const event of all) {
    visible++
    ctx.emit('session/event' as never, fake as never, event as never)
  }
}

async function call<T>(method: string, request?: unknown): Promise<T> {
  const args = request === undefined ? {} : { request }
  return await ctx.typertGateway.invoke({ namespace: 'tally', method, args }) as T
}

async function codeOf(method: string, request?: unknown): Promise<string | undefined> {
  try {
    await call(method, request)
  } catch (error) {
    return remoteErrorOf(error)?.code
  }
  throw new Error(`tally/${method} did not fail`)
}

beforeEach(() => {
  // Fixture events are dated 2026-10-14; the price version in the catalog is effective from 2026-10-10.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'))
  dir = mkdtempSync(join(tmpdir(), 'dsh-tally-remote-api-'))
})

afterEach(async () => {
  await fiber?.dispose()
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

/** Ledger used by most tests: priced peak, unpriced, off-peak and unknown-usage entries. */
function fill(): void {
  record('main', seqd([...turn(1, U1), ...turn(2, U2)])) // main:3 (U1) and main:9 (U2), both peak
  record('other', seqd(turn(1, U1, 'mystery', 'x')), '/work,dir "q"') // other:3, no price
  record('night', shifted(seqd(turn(1, U1)), sh('2026-10-14T20:00:00'))) // night:3, off-peak
  record('blind', seqd([turnStart(1), header('deepseek-official', 'deepseek-flash'), stepStart(1, 1), message(1, 1, undefined), stepEnd(1, 1), turnEnd(1)])) // blind:3, unknown usage
}

describe('tally Remote API', () => {
  it('describes exactly the implemented methods for the browser', async () => {
    await start()
    expect(TALLY_REMOTE.descriptors.map(d => d.method).sort()).toEqual([
      'balance', 'band', 'budgets', 'catalog', 'exportCsv', 'peakSavings', 'query', 'rebuild',
      'refreshBalance', 'removeBudget', 'session', 'setBudget', 'status', 'turn', 'watch',
    ])
    expect(Object.keys(schemas).sort()).toEqual(TALLY_REMOTE.descriptors.map(d => d.method).sort())
  })

  it('answers query like the usage service does', async () => {
    await start()
    fill()
    const request = { from: T0 - 1000, to: T0 + DAY, groupBy: 'session' as const, filter: { rootSessionId: 'main' } }
    const result = await call<UsageGroup[]>('query', request)
    expect(result).toEqual(await ctx.tallyUsage.query(request))
    expect(result.map(g => [g.key, g.requestCount])).toEqual([['main', 2]])
    expect(() => schemas.query.result.parse(result)).not.toThrow()
  })

  it('answers session with usage and the latest route', async () => {
    await start()
    fill()
    const view = await call<SessionView>('session', { sessionId: 'main' })
    expect(view).toEqual({ usage: await ctx.tallyUsage.session('main'), lastRoute: 'deepseek-official', lastModel: 'deepseek-flash' })
    expect(view.usage.total.requestCount).toBe(2)
    expect(() => schemas.session.result.parse(view)).not.toThrow()

    const other = await call<SessionView>('session', { sessionId: 'other' })
    expect([other.lastRoute, other.lastModel]).toEqual(['mystery', 'x'])
    const unknown = await call<SessionView>('session', { sessionId: 'nobody' })
    expect(unknown.usage.total.requestCount).toBe(0)
    expect([unknown.lastRoute, unknown.lastModel]).toEqual([null, null])
  })

  it('returns only the session entries inside the seq range, oldest first', async () => {
    await start()
    fill()
    const first = await call<TurnUsage>('turn', { sessionId: 'main', fromSeq: 0, toSeq: 5 })
    expect(first.attempts.map(e => e.id)).toEqual(['main:3'])
    expect(first.attempts[0]).toMatchObject({ band: 'peak', cost: { amount: '0.000636', currency: 'CNY' }, tokens: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50 } })
    expect(first.total.requestCount).toBe(1)
    expect(first.total.cost).toEqual([{ amount: '0.000636', currency: 'CNY' }])

    const both = await call<TurnUsage>('turn', { sessionId: 'main', fromSeq: 3, toSeq: 9 }) // closed interval
    expect(both.attempts.map(e => e.id)).toEqual(['main:3', 'main:9'])
    expect(both.attempts.map(e => e.at)).toEqual([T0 + 2000, T0 + 8000])
    expect(both.total.requestCount).toBe(2)
    expect((await call<TurnUsage>('turn', { sessionId: 'main', fromSeq: 4, toSeq: 8 })).attempts).toEqual([])
    const empty = await call<TurnUsage>('turn', { sessionId: 'main', fromSeq: 4, toSeq: 8 })
    expect(empty.total).toMatchObject({ requestCount: 0, cost: [], tokens: { input: 0 } })
    expect(() => schemas.turn.result.parse(both)).not.toThrow()
  })

  it('reports the band with its countdown, following overrides', async () => {
    await start({
      overrides: [
        { provider: 'my-route', kind: 'manual', currency: 'USD', models: { m: { input: '1', output: '2' } } },
        { provider: 'proxy', kind: 'alias', target: { provider: 'deepseek' } },
      ],
    })
    const at = sh('2026-10-14T10:00:00')
    const peak = await call<BandView | null>('band', { route: 'deepseek-official', model: 'deepseek-flash', at })
    expect(peak).toEqual({ band: 'peak', until: sh('2026-10-14T12:00:00'), holidayCalendarMissing: true })
    expect(() => schemas.band.result.parse(peak)).not.toThrow()
    expect(await call('band', { route: 'deepseek-official', model: 'deepseek-flash', at: sh('2026-10-17T10:00:00') }))
      .toEqual({ band: 'offpeak', until: sh('2026-10-19T09:00:00'), holidayCalendarMissing: false })
    expect(await call('band', { route: 'proxy', model: 'deepseek-flash', at })).toEqual(peak)
    expect(await call('band', { route: 'my-route', model: 'm', at })).toEqual({ band: 'flat', until: null, holidayCalendarMissing: false })
    expect(await call('band', { route: 'my-route', model: 'unpriced', at })).toBeNull()
    expect(await call('band', { route: 'nobody', model: 'x', at })).toBeNull()
    expect(await call('band', { route: 'deepseek-official', model: 'deepseek-flash', at: sh('2026-10-01T10:00:00') })).toBeNull()
  })

  it('reads and refreshes balances', async () => {
    await start()
    let fetches = 0
    ctx.tallyBalance.register('r1', async () => {
      fetches++
      return [{ kind: 'total', money: { amount: String(10 + fetches), currency: 'CNY' } }]
    })
    ctx.tallyBalance.register('r2', async () => { throw new Error('boom') })
    const first = await call<BalanceSnapshot | null>('balance', { route: 'r1' })
    expect(first).toMatchObject({ provider: 'r1', wallets: [{ kind: 'total', money: { amount: '11', currency: 'CNY' } }], stale: false })
    expect(await call('balance', { route: 'r1' })).toEqual(first) // cached
    expect(fetches).toBe(1)
    const refreshed = await call<BalanceSnapshot | null>('refreshBalance', { route: 'r1' })
    expect(refreshed!.wallets[0]!.money.amount).toBe('12')
    expect(() => schemas.balance.result.parse(refreshed)).not.toThrow()
    const failed = await call<BalanceSnapshot | null>('refreshBalance', { route: 'r2' })
    expect(failed).toMatchObject({ provider: 'r2', wallets: [], stale: true, error: 'boom' })
    expect(() => schemas.balance.result.parse(failed)).not.toThrow()
    expect(await call('balance', { route: 'nobody' })).toBeNull()
    expect(await call('refreshBalance', { route: 'nobody' })).toBeNull()
  })

  it('lists, sets and removes budgets', async () => {
    await start()
    const budget: Budget = { id: 'daily', period: 'day', scope: {}, limit: { amount: '5', currency: 'CNY' } }
    expect(await call('budgets')).toEqual([])
    expect(await call('setBudget', budget)).toBeUndefined()
    expect(await call<Budget[]>('budgets')).toEqual([budget])
    expect(ctx.tallyBudget.list()).toEqual([budget])

    const before = budgetFile()
    expect(await codeOf('setBudget', { ...budget, limit: { amount: '-1', currency: 'CNY' } })).toBe('tally/invalid-budget')
    expect(await codeOf('setBudget', { ...budget, id: '' })).toBe('tally/invalid-budget')
    expect(budgetFile()).toBe(before)
    expect(await call<Budget[]>('budgets')).toEqual([budget])

    expect(await codeOf('removeBudget', { id: 'nope' })).toBe('tally/not-found')
    expect(await call('removeBudget', { id: 'daily' })).toBeUndefined()
    expect(await call('budgets')).toEqual([])
    expect(await codeOf('removeBudget', { id: 'daily' })).toBe('tally/not-found')
  })

  it('carries the invalid-budget reason in the message', async () => {
    await start()
    try {
      await call('setBudget', { id: 'b', period: 'day', scope: {}, limit: { amount: '-1', currency: 'CNY' } })
      throw new Error('expected failure')
    } catch (error) {
      expect(remoteErrorOf(error)?.message).toContain('limit.amount')
    }
  })

  it('lists the bundled catalog with the versions in effect now', async () => {
    await start()
    const view = await call<CatalogView>('catalog')
    expect(view.version).toBe(ctx.tallyPricing.catalogVersion())
    expect(view.providers.map(p => [p.id, p.currency])).toEqual([['deepseek', 'CNY']])
    expect(view.providers[0]!.models.map(m => m.model)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(view.providers[0]!.models[0]).toEqual({
      model: 'deepseek-flash',
      priceVersion: 'deepseek-flash@2026-10-10',
      effectiveFrom: '2026-10-10T00:00:00+08:00',
      source: expect.objectContaining({ url: expect.any(String), retrievedAt: expect.any(String) }),
    })
    expect(() => schemas.catalog.result.parse(view)).not.toThrow()
    // Before the first verified version nothing is in effect.
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
    expect((await call<CatalogView>('catalog')).providers[0]!.models).toEqual([])
  })

  it('prices peak requests at the off-peak rate for peakSavings', async () => {
    await start()
    fill()
    // Range covers main:3 (peak, 0.000636), other:3 (unpriced) and blind:3 (unknown usage); main:9 and night:3 are outside or off-peak.
    const savings = await call<PeakSavings>('peakSavings', { from: T0, to: T0 + 5000 })
    expect(savings).toEqual({
      peak: [{ amount: '0.000636', currency: 'CNY' }],
      offpeakEquivalent: [{ amount: '0.000318', currency: 'CNY' }],
      saving: [{ amount: '0.000318', currency: 'CNY' }],
    })
    expect(() => schemas.peakSavings.result.parse(savings)).not.toThrow()
    // Two peak entries add up; the off-peak entry (night) contributes nothing.
    const all = await call<PeakSavings>('peakSavings', { from: T0, to: sh('2026-10-15T00:00:00') })
    const peakCost = (await ctx.tallyUsage.query({ from: T0, to: sh('2026-10-15T00:00:00'), groupBy: 'model', filter: { band: 'peak' } }))[0]!.cost
    expect(all.peak).toEqual(peakCost)
    expect(await call('peakSavings', { from: sh('2026-10-14T19:00:00'), to: sh('2026-10-14T21:00:00') }))
      .toEqual({ peak: [], offpeakEquivalent: [], saving: [] })
  })

  it('exports one CSV row per entry with an empty cost for unpriced rows', async () => {
    await start()
    fill()
    const csv = await call<string>('exportCsv', { from: T0, to: sh('2026-10-15T00:00:00'), tz: 'Asia/Shanghai' })
    const lines = csv.trimEnd().split('\n')
    expect(lines[0]).toBe('time,session,root_session,workspace,route,model,band,input,cache_read,cache_write,output,cost,currency,price_version,usage_known')
    expect(lines).toHaveLength(1 + 5) // main x2, other, blind, night
    const totalEntries = (await ctx.tallyUsage.query({ from: T0, to: sh('2026-10-15T00:00:00'), groupBy: 'day', tz: 'Asia/Shanghai' }))
      .reduce((n, g) => n + g.requestCount, 0)
    expect(lines.length - 1).toBe(totalEntries)

    expect(lines.find(l => l.includes(',main,'))).toBe('2026-10-14T10:00:02.000+08:00,main,main,/work,deepseek-official,deepseek-flash,peak,100,900,0,50,0.000636,CNY,deepseek-flash@2026-10-10,true')
    // Unpriced route: no band, no cost, no currency, no price version; the workspace is quoted.
    const other = lines.find(l => l.includes(',other,'))!
    expect(other).toBe('2026-10-14T10:00:02.000+08:00,other,other,"/work,dir ""q""",mystery,x,,100,900,0,50,,,,true')
    // Unknown usage is never priced either.
    expect(lines.find(l => l.includes(',blind,'))).toBe('2026-10-14T10:00:02.000+08:00,blind,blind,/work,deepseek-official,deepseek-flash,,0,0,0,0,,,,false')
    expect(lines.find(l => l.includes(',night,'))).toContain('2026-10-14T20:00:02.000+08:00,night,night,/work,deepseek-official,deepseek-flash,offpeak,')
    // Rows are ordered by time.
    expect(lines.slice(1).map(l => l.split(',')[0])).toEqual([...lines.slice(1).map(l => l.split(',')[0])].sort())

    const utc = await call<string>('exportCsv', { from: T0, to: T0 + 5000, tz: 'UTC' })
    expect(utc).toContain('2026-10-14T02:00:02.000+00:00,main,')
    expect(await call<string>('exportCsv', { from: T0 + DAY, to: T0 + 2 * DAY, tz: 'UTC' }))
      .toBe('time,session,root_session,workspace,route,model,band,input,cache_read,cache_write,output,cost,currency,price_version,usage_known\n')
  })

  it('rebuilds the ledger', async () => {
    await start()
    fill()
    expect(await call('rebuild')).toBeUndefined()
    // Live sessions are not listed by the empty sessionQuery, so a rebuild leaves nothing.
    expect(await call<UsageGroup[]>('query', { from: T0 - DAY, to: T0 + DAY, groupBy: 'model' })).toEqual([])
  })

  describe('request validation', () => {
    const base = { from: T0, to: T0 + DAY }
    const longText = 'x'.repeat(300)
    const cases: Array<[string, string, unknown]> = [
      ['query without from', 'query', { to: T0, groupBy: 'day' }],
      ['query with from after to', 'query', { from: T0 + 1, to: T0, groupBy: 'day' }],
      ['query with from equal to', 'query', { from: T0, to: T0, groupBy: 'day' }],
      ['query over 400 days', 'query', { from: T0, to: T0 + 401 * DAY, groupBy: 'day' }],
      ['query with an unknown grouping', 'query', { ...base, groupBy: 'hour' }],
      ['query with a long filter', 'query', { ...base, groupBy: 'day', filter: { model: longText } }],
      ['query with an unknown time zone', 'query', { ...base, groupBy: 'day', tz: 'Mars/Base' }],
      ['query with a non-object request', 'query', 'now'],
      ['query without a request', 'query', undefined],
      ['session with a long id', 'session', { sessionId: longText }],
      ['session without an id', 'session', {}],
      ['turn with fromSeq after toSeq', 'turn', { sessionId: 's', fromSeq: 5, toSeq: 4 }],
      ['turn with a fractional seq', 'turn', { sessionId: 's', fromSeq: 0.5, toSeq: 4 }],
      ['turn with a long session id', 'turn', { sessionId: longText, fromSeq: 0, toSeq: 1 }],
      ['band with a long model', 'band', { route: 'r', model: longText, at: T0 }],
      ['band with a non-numeric time', 'band', { route: 'r', model: 'm', at: 'now' }],
      ['balance with a long route', 'balance', { route: longText }],
      ['refreshBalance without a route', 'refreshBalance', {}],
      ['setBudget with a malformed period', 'setBudget', { id: 'b', period: 'week', scope: {}, limit: { amount: '1', currency: 'CNY' } }],
      ['setBudget with a long id', 'setBudget', { id: longText, period: 'day', scope: {}, limit: { amount: '1', currency: 'CNY' } }],
      ['removeBudget with a long id', 'removeBudget', { id: longText }],
      ['peakSavings without from', 'peakSavings', { to: T0 }],
      ['peakSavings over 401 days', 'peakSavings', { from: T0, to: T0 + 401 * DAY }],
      ['exportCsv with from after to', 'exportCsv', { from: T0 + 1, to: T0, tz: 'UTC' }],
      ['exportCsv with an unknown time zone', 'exportCsv', { ...base, tz: 'Mars/Base' }],
      ['exportCsv with a long time zone', 'exportCsv', { ...base, tz: longText }],
    ]

    it.each(cases)('rejects %s with gateway/bad-request', async (_name, method, request) => {
      await start()
      expect(await codeOf(method, request)).toBe('gateway/bad-request')
    })

    it('accepts a range of exactly 400 days', async () => {
      await start()
      await expect(call('peakSavings', { from: T0, to: T0 + 400 * DAY })).resolves.toBeDefined()
      await expect(call('query', { from: T0, to: T0 + 400 * DAY, groupBy: 'day' })).resolves.toEqual([])
    })
  })
})
