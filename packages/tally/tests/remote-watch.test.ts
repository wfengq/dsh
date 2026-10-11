import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import type { BalanceSnapshot, BudgetAlert, TallyEntry } from 'dsh-tally-api'
import * as tally from '../src/index.js'
import { schemas, TALLY_REMOTE } from '../src/remote/contract.js'
import type { TallyRemote } from '../src/remote/service.js'
import { header, message, seqd, stepEnd, stepStart, turnEnd, turnStart, U1 } from './fixtures/events.ts'

/** Stand-in for the official `sessionQuery` service; reads wait on a gate the test controls. */
class FakeSessionQuery extends Service {
  ids: string[] = []
  gate: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'sessionQuery')
  }

  async listSessions() {
    return this.ids.map(id => ({ header: { id, createdAt: 0, cwd: '/work' }, live: false, persisted: true }))
  }

  async readSession(id: string) {
    await this.gate
    const events = seqd([turnStart(1), header('deepseek-official', 'deepseek-flash'), stepStart(1, 1), message(1, 1, U1), stepEnd(1, 1), turnEnd(1)])
    return { session: { id, createdAt: 0, cwd: '/work' }, inheritedEventCount: 0, events }
  }
}

const EVENTS = ['tally/recorded', 'tally/balance-changed', 'tally/budget-crossed']

let dir: string
let ctx: Context
let fiber: { dispose(): Promise<void> }
let remote: TallyRemote

function listeners(): number[] {
  const hooks = (ctx.events as unknown as { _hooks: Record<string, unknown[] | undefined> })._hooks
  return EVENTS.map(name => hooks[name]?.length ?? 0)
}

const entry = (n: number) => ({ id: 'e' + String(n) }) as unknown as TallyEntry
const snapshot = { provider: 'p', wallets: [], fetchedAt: 1, stale: false } as BalanceSnapshot
const alert = { budgetId: 'b', threshold: 0.8 } as unknown as BudgetAlert

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-tally-watch-'))
  ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService, {})
  await ctx.plugin(FakeSessionQuery)
  const loading = ctx.plugin(tally, { dbPath: join(dir, 'tally.v1.sqlite'), budgetPath: join(dir, 'budgets.json'), backfillBatch: 1 })
  fiber = loading
  await loading
  await new Promise<void>(resolve => ctx.inject(['tallyRemote'], () => resolve()))
  remote = ctx.get('tallyRemote') as unknown as TallyRemote
  await (ctx.tallyUsage as unknown as { idle(): Promise<void> }).idle()
})

afterEach(async () => {
  vi.useRealTimers()
  await fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('tally/watch', () => {
  it('starts with hello, forwards events in order and removes its listeners on abort', async () => {
    const before = listeners()
    const ac = new AbortController()
    const it = remote.watch(ac.signal)[Symbol.asyncIterator]()
    const first = (await it.next()).value
    expect(first.type).toBe('hello')
    expect(() => schemas.watch.result.parse(first)).not.toThrow()
    expect(listeners()).toEqual(before.map(n => n + 1))

    ctx.emit('tally/recorded', entry(1))
    ctx.emit('tally/balance-changed', snapshot)
    ctx.emit('tally/budget-crossed', alert)
    expect((await it.next()).value).toEqual({ type: 'recorded', entry: entry(1) })
    expect((await it.next()).value).toEqual({ type: 'balance-changed', snapshot })
    expect((await it.next()).value).toEqual({ type: 'budget-crossed', alert })

    const pending = it.next()
    ac.abort()
    expect((await pending).done).toBe(true)
    expect(listeners()).toEqual(before)
  })

  it('drops the oldest frames beyond 1000 and refreshes the client with a new hello', async () => {
    const ac = new AbortController()
    const it = remote.watch(ac.signal)[Symbol.asyncIterator]()
    expect((await it.next()).value.type).toBe('hello')
    for (let i = 0; i < 1001; i++) ctx.emit('tally/recorded', entry(i))
    expect((await it.next()).value.type).toBe('hello')
    // The oldest frame (e0) was dropped; the queue resumes at e1.
    expect((await it.next()).value).toEqual({ type: 'recorded', entry: entry(1) })
    ac.abort()
  })

  it('is served as a stream through the Gateway, with a stream descriptor', async () => {
    const ac = new AbortController()
    const frames = await ctx.typertGateway.stream({ namespace: 'tally', method: 'watch', args: {}, signal: ac.signal })
    const it = frames[Symbol.asyncIterator]()
    expect(((await it.next()).value as { type: string }).type).toBe('hello')
    ac.abort()
    const descriptor = TALLY_REMOTE.descriptors.find(d => d.method === 'watch')!
    expect(descriptor.mode).toBe('stream')
    expect(descriptor.parameters).toEqual([])
    expect(descriptor.cancellation).toEqual({ parameter: 'signal' })
  })

  it('pushes status frames at least 1000 ms apart during a rebuild and a final one without backfill', async () => {
    const query = ctx.get('sessionQuery') as unknown as FakeSessionQuery
    query.ids = ['a', 'b', 'c', 'd']
    let release!: () => void
    query.gate = new Promise<void>(resolve => { release = resolve })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'))

    const ac = new AbortController()
    const seen: Array<{ at: number; backfill: { done: number; total: number } | null }> = []
    const reader = (async () => {
      for await (const frame of remote.watch(ac.signal)) {
        if (frame.type === 'status') seen.push({ at: Date.now(), backfill: frame.status.usage.backfill })
      }
    })()
    await vi.advanceTimersByTimeAsync(0)

    const rebuilding = ctx.tallyUsage.rebuild()
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(300)
    release()
    await rebuilding
    await vi.advanceTimersByTimeAsync(2000)
    ac.abort()
    await reader

    expect(seen.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.at - seen[i - 1]!.at).toBeGreaterThanOrEqual(1000)
    expect(seen.at(-1)!.backfill).toBeNull()
  })
})
