import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TallyWatchFrame } from 'dsh-tally-api'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./support/primitives.tsx'))

const { apply, inject } = await import('../src/client/index.ts')

const ok = <T>(value: T) => ({ ok: true as const, value })

interface Registration {
  name: string
  id: string
  order?: number
  locale?: string
  inject?: (...args: unknown[]) => Record<string, unknown>
}

/**
 * A minimal browser plugin context. `@deepseek-ai/dsh-client-test-runtime` cannot be imported
 * outside the dsh repository (its entry imports unshipped renderer sources), so this records what
 * the plugin asks of `slots`, `locale`, `remote` and `configForms`.
 */
function fakeContext() {
  const disposers: (() => unknown)[] = []
  const registrations: Registration[] = []
  const injected: string[] = []
  const frames: TallyWatchFrame[] = [{ type: 'hello', status: {
    usage: { backfill: null, errors: [] }, catalogVersion: 'v1', pricingErrors: [], budgetErrors: [], balanceRoutes: [],
  } }]
  const accepted: number[] = []
  const stream = {
    dispose: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() {
      for (const [i, frame] of frames.entries()) yield { generation: 1, value: frame, signal: new AbortController().signal, accept: () => { accepted.push(i) } }
      await new Promise(() => {})
    },
  }
  const tally = {
    status: vi.fn(async () => ok(frames[0])),
    query: vi.fn(async () => ok([])),
    session: vi.fn(async () => ok({ usage: { sessionId: 's1', total: { key: '', tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: [], requestCount: 0, unpricedCount: 0, unknownUsageCount: 0 }, children: [] }, lastRoute: null, lastModel: null })),
    balance: vi.fn(async () => ok(null)),
    refreshBalance: vi.fn(async () => ok(null)),
    turn: vi.fn(async () => ok({ total: {}, attempts: [] })),
    band: vi.fn(async () => ok(null)),
    catalog: vi.fn(async () => ok({ version: 'v1', providers: [] })),
    watch: vi.fn(),
  }
  const remote = {
    $mount: vi.fn(async () => {}),
    $stream: vi.fn((options: { name: string; open: (signal: AbortSignal) => unknown; ended: (accepted: boolean) => Error }) => {
      options.open(new AbortController().signal)
      return stream
    }),
    tally,
  }
  const form = { getSnapshot: vi.fn(() => ({ status: 'loading', value: undefined })), subscribe: vi.fn(() => () => {}) }
  const ctx = {
    remote,
    configForms: { get: vi.fn(() => form) },
    locale: { register: vi.fn(() => () => {}) },
    slots: {
      inject: (name: string, register: () => () => void) => { injected.push(name); disposers.push(register()) },
      register: (options: Registration) => { registrations.push(options); return () => {} },
    },
    effect: (fn: () => unknown) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose as () => unknown) },
    inject: (_deps: string[], fn: (scope: unknown) => void) => { fn(ctx) },
  }
  return { ctx, registrations, injected, disposers, remote, stream, tally, form, accepted }
}

afterEach(() => { vi.restoreAllMocks() })

describe('dsh-tally-ui browser plugin', () => {
  it('needs the config forms service', () => {
    expect(inject).toContain('configForms')
  })

  it('registers one element in each conversation slot with the documented ids', async () => {
    const { ctx, registrations } = fakeContext()
    await apply(ctx as never)
    const byName = Object.fromEntries(registrations.map(r => [r.name, r.id]))
    expect(byName).toEqual({
      'conversation.composer.dock': 'tally.dock',
      'conversation.chat.turnTail': 'tally.turn',
      'conversation.session.header.utilities': 'tally.total',
      'shell.overlay': 'tally.budget',
    })
    expect(registrations).toHaveLength(4)
    expect(registrations.every(r => r.locale === 'tally')).toBe(true)
  })

  it('reads the element switches from the tally-ui config form', async () => {
    const { ctx } = fakeContext()
    await apply(ctx as never)
    expect(ctx.configForms.get).toHaveBeenCalledWith('tally-ui')
  })

  it('feeds the store from the reconnecting tally stream and accepts its frames', async () => {
    const { ctx, remote, tally, accepted } = fakeContext()
    await apply(ctx as never)
    expect(remote.$stream).toHaveBeenCalledWith(expect.objectContaining({ name: 'tally' }))
    expect(tally.watch).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => { expect(accepted).toEqual([0]) })
    await vi.waitFor(() => { expect(tally.query).toHaveBeenCalled() })
  })

  it('binds the turn call to the turn sequence range and the session', async () => {
    const { ctx, registrations, tally } = fakeContext()
    await apply(ctx as never)
    const face = registrations.find(r => r.id === 'tally.turn')!.inject!('s1') as {
      loadTurn: (request: { sessionId: string; fromSeq: number; toSeq: number }) => Promise<unknown>
    }
    await face.loadTurn({ sessionId: 's1', fromSeq: 3, toSeq: 7 })
    expect(tally.turn).toHaveBeenCalledWith({ sessionId: 's1', fromSeq: 3, toSeq: 7 })
  })

  it('hands each session-scope element the session snapshot of its session', async () => {
    const { ctx, registrations } = fakeContext()
    await apply(ctx as never)
    for (const id of ['tally.dock', 'tally.total']) {
      const face = registrations.find(r => r.id === id)!.inject!('s1') as { hooks: Record<string, unknown> }
      expect(Object.keys(face.hooks)).toEqual(expect.arrayContaining(['elements', 'session']))
    }
  })

  it('disposes the stream when the plugin unloads', async () => {
    const { ctx, disposers, stream } = fakeContext()
    await apply(ctx as never)
    for (const dispose of disposers) await dispose()
    expect(stream.dispose).toHaveBeenCalled()
  })
})
