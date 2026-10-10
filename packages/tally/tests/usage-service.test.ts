import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service, type Message } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TallyEntry } from 'dsh-tally-api'
import * as tally from '../src/index.js'
import type { TallyUsage } from '../src/usage-service.js'
import {
  header, message, seqd, stepEnd, stepStart, turnEnd, turnStart, U1, U2,
} from './fixtures/events.ts'

interface FakeSession {
  header: { id: string; createdAt: number; cwd?: string; origin?: 'subagent'; parentSession?: string }
  inheritedEventCount: number
  events: SessionEvent[]
  /** Thrown by `readSession`. */
  error?: Error
}

/** Minimal stand-in for the official `sessionQuery` service. */
class FakeSessionQuery extends Service {
  sessions: FakeSession[] = []
  reads: string[] = []
  listSignal: AbortSignal | undefined
  gate: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'sessionQuery')
  }

  async listSessions(signal?: AbortSignal) {
    this.listSignal = signal
    return this.sessions.map(s => ({ header: s.header, live: false, persisted: true }))
  }

  async readSession(id: string) {
    this.reads.push(id)
    await this.gate
    const s = this.sessions.find(x => x.header.id === id)
    if (!s) throw new Error('not found')
    if (s.error) throw s.error
    return { session: s.header, inheritedEventCount: s.inheritedEventCount, events: s.events }
  }
}

const turn = (n: number, usage = U1) => [
  turnStart(n), header('deepseek-official', 'deepseek-flash'), stepStart(n, 1), message(n, 1, usage), stepEnd(n, 1),
  turnEnd(n),
]

function session(id: string, events: SessionEvent[], inheritedEventCount = 0, extra: Partial<FakeSession['header']> = {}): FakeSession {
  return { header: { id, createdAt: 0, cwd: '/work', ...extra }, inheritedEventCount, events }
}

let dir: string
let ctx: Context
let query: FakeSessionQuery
let logs: Message[]

beforeEach(async () => {
  // Fixture events are dated 2026-10-14; pin the clock after them so `to: Date.now() + 1` covers them.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'))
  dir = mkdtempSync(join(tmpdir(), 'dsh-tally-usage-'))
  ctx = new Context()
  logs = []
  ctx.logger.exporter({ levels: { default: 3 }, export: m => { logs.push(m) } })
  await ctx.plugin(FakeSessionQuery)
  query = ctx.get('sessionQuery') as unknown as FakeSessionQuery
})

afterEach(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

const fibers: Array<{ dispose(): Promise<void> }> = []

async function load(config: Partial<tally.Config> = {}): Promise<TallyUsage> {
  const fiber = ctx.plugin(tally, { dbPath: join(dir, 'tally.v1.sqlite'), ...config })
  fibers.push(fiber)
  await fiber
  return ctx.get('tallyUsage') as unknown as TallyUsage
}

function corpus(): FakeSession[] {
  // Inherited prefix (seq 0-2) is one settled attempt that belongs to the parent.
  const forkLog = seqd([
    stepStart(1, 1), message(1, 1, U1), stepEnd(1, 1),
    ...turn(2, U2),
  ])
  const bad = session('bad', [])
  bad.error = new Error('migration-required')
  return [
    session('main', seqd([...turn(1), ...turn(2)])),
    bad,
    session('fork', forkLog, 3, { parentSession: 'main' }),
  ]
}

function liveSession(id: string) {
  const all = seqd([...turn(1)])
  let visible = 0
  const fake = {
    id,
    header: { id, createdAt: 0, cwd: '/live' },
    inheritedEventCount: 0,
    isOwnSeq: (seq: number) => seq >= 0,
    ownEvents: () => all.slice(0, visible),
  }
  return {
    fake,
    all,
    emitNext(target: Context) {
      const event = all[visible++]!
      target.emit('session/event' as never, fake as never, event as never)
    },
  }
}

describe('dsh-tally plugin', () => {
  it('backfills history, records live events, and rebuilds to the same ledger', async () => {
    query.sessions = corpus()
    const usage = await load()
    await usage.idle()

    const status = usage.status()
    expect(status.errors).toHaveLength(1)
    expect(status.errors[0]).toMatchObject({ sessionId: 'bad' })
    expect(status.errors[0]!.message).toContain('migration-required')
    expect(status.backfill).toEqual({ done: 3, total: 3 })

    const bySession = await usage.query({ from: 0, to: Date.now() + 1, groupBy: 'session' })
    expect(bySession.map(g => [g.key, g.requestCount])).toEqual([['fork', 1], ['main', 2]])
    // The inherited attempt at fork seq 1 was not recorded; only the fork's own turn (U2).
    const fork = bySession.find(g => g.key === 'fork')!
    expect(fork.tokens).toEqual({ input: 10, cacheRead: 0, cacheWrite: 0, output: 5 })

    const recorded: TallyEntry[] = []
    ctx.on('tally/recorded', e => { recorded.push(e) })
    const live = liveSession('live')
    for (let i = 0; i < live.all.length; i++) live.emitNext(ctx)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      id: 'live:3',
      sessionId: 'live',
      rootSessionId: 'live',
      workspaceId: '/live',
      route: 'deepseek-official',
      provider: 'deepseek',
      model: 'deepseek-flash',
      band: 'peak',
      tokens: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50 },
      cost: { amount: '0.000636', currency: 'CNY' },
      priceVersion: 'deepseek-flash@2026-10-10',
      usageKnown: true,
    })

    // Re-delivering an event (or a backfill racing the live path) never duplicates.
    live.fake.ownEvents = () => live.all
    ctx.emit('session/event' as never, live.fake as never, live.all[3] as never)
    expect(recorded).toHaveLength(1)

    const count = async () => (await usage.query({ from: 0, to: Date.now() + 1, groupBy: 'model' }))
      .reduce((n, g) => n + g.requestCount, 0)
    expect(await count()).toBe(4)

    // The live session is now part of the corpus, so a rebuild reproduces every entry.
    query.sessions.push(session('live', live.all, 0, { cwd: '/live' }))
    await usage.rebuild()
    expect(await count()).toBe(4)
    expect(usage.status().errors).toHaveLength(1)
    expect(usage.status().backfill).toEqual({ done: 4, total: 4 })
  })

  it('skips inherited events on the live path', async () => {
    const usage = await load()
    await usage.idle()
    const recorded: TallyEntry[] = []
    ctx.on('tally/recorded', e => { recorded.push(e) })
    const all = seqd([stepStart(1, 1), message(1, 1, U1), stepEnd(1, 1), ...turn(2, U2)])
    const fake = {
      id: 'f',
      header: { id: 'f', createdAt: 0, parentSession: 'p' },
      inheritedEventCount: 3,
      isOwnSeq: (seq: number) => seq >= 3,
      ownEvents: () => all.slice(3),
    }
    for (const event of all) ctx.emit('session/event' as never, fake as never, event as never)
    expect(recorded.map(e => e.id)).toEqual(['f:6'])
    expect(recorded[0]!.workspaceId).toBeUndefined()
    void usage
  })

  it('catches up from the own log when the first live event is not the next one', async () => {
    const usage = await load()
    await usage.idle()
    const recorded: TallyEntry[] = []
    ctx.on('tally/recorded', e => { recorded.push(e) })
    const all = seqd([...turn(1), ...turn(2)])
    const fake = { id: 'm', header: { id: 'm', createdAt: 0 }, inheritedEventCount: 0, isOwnSeq: () => true, ownEvents: () => all }
    ctx.emit('session/event' as never, fake as never, all[all.length - 1] as never)
    expect(recorded.map(e => e.id)).toEqual(['m:3', 'm:9'])
  })

  it('attributes live sub-agent entries to the root session', async () => {
    query.sessions = [session('main', seqd(turn(1)))]
    const usage = await load()
    await usage.idle()
    const recorded: TallyEntry[] = []
    ctx.on('tally/recorded', e => { recorded.push(e) })
    const all = seqd(turn(1))
    const fake = {
      id: 'kid',
      header: { id: 'kid', createdAt: 0, origin: 'subagent', parentSession: 'main' },
      inheritedEventCount: 0,
      isOwnSeq: () => true,
      ownEvents: () => all,
    }
    for (const event of all) ctx.emit('session/event' as never, fake as never, event as never)
    expect(recorded.map(e => [e.sessionId, e.rootSessionId])).toEqual([['kid', 'main']])
    const tree = await usage.session('main')
    expect(tree.total.requestCount).toBe(2)
    expect(tree.children.map(c => c.sessionId)).toEqual(['kid'])
  })

  it('records unknown usage without a cost', async () => {
    const usage = await load()
    await usage.idle()
    const recorded: TallyEntry[] = []
    ctx.on('tally/recorded', e => { recorded.push(e) })
    const all = seqd([
      turnStart(1), header('deepseek-official', 'deepseek-flash'), stepStart(1, 1), message(1, 1, undefined),
      stepEnd(1, 1), turnEnd(1),
    ])
    const fake = { id: 'u', header: { id: 'u', createdAt: 0 }, inheritedEventCount: 0, isOwnSeq: () => true, ownEvents: () => all }
    for (const event of all) ctx.emit('session/event' as never, fake as never, event as never)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ usageKnown: false, cost: null, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } })
  })

  it('ignores an invalid price override, logs it and reports it in status', async () => {
    const usage = await load({
      overrides: [
        { provider: 'bad-gateway', kind: 'manual', currency: 'CNY', models: { m: { input: 'abc', output: '1' } } },
        { provider: 'good-gateway', kind: 'alias', target: { provider: 'deepseek' } },
      ],
    })
    await usage.idle()
    const errors = usage.status().errors
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('bad-gateway')
    const usageCounts = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const at = Date.parse('2026-10-14T10:00:00+08:00')
    expect(ctx.tallyPricing.quote({ provider: 'good-gateway', model: 'deepseek-flash', usage: usageCounts, at })?.amount).toBe('2')
    expect(ctx.tallyPricing.quote({ provider: 'bad-gateway', model: 'm', usage: usageCounts, at })).toBeNull()
    expect(ctx.tallyPricing.overrides().map(o => o.provider)).toEqual(['good-gateway'])
    const warned = logs.filter(m => m.type === 'warn' && String(m.args[0]).includes('bad-gateway'))
    expect(warned).toHaveLength(1)
  })

  it('runs the backfill in the background and stops it on dispose', async () => {
    query.sessions = corpus()
    let release!: () => void
    query.gate = new Promise<void>(resolve => { release = resolve })
    const fiber = ctx.plugin(tally, { dbPath: join(dir, 'tally.v1.sqlite'), backfillBatch: 1 })
    await fiber // apply returns while the first read is still blocked
    const usage = ctx.get('tallyUsage') as unknown as TallyUsage
    await waitUntil(() => query.reads.length === 1)
    expect(usage.status().backfill).toEqual({ done: 0, total: 3 })

    const disposed = fiber.dispose()
    await waitUntil(() => query.listSignal?.aborted === true)
    release()
    await disposed
    expect(query.reads).toEqual(['main'])
  })
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}
