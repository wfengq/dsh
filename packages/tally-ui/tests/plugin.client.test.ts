import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TallyWatchFrame } from 'dsh-tally-api'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./support/primitives.tsx'))

const { apply, inject } = await import('../src/client/index.ts')

const ok = <T>(value: T) => ({ ok: true as const, value })

interface Registration {
  name: string
  id?: string
  key?: string
  order?: number
  locale?: string
  inject?: (...args: unknown[]) => Record<string, unknown>
}

/**
 * A minimal browser plugin context. `@deepseek-ai/dsh-client-test-runtime` cannot be imported
 * outside the dsh repository (its entry imports unshipped renderer sources), so this records what
 * the plugin asks of `slots`, `locale`, `remote` and `configForms`.
 */
function fakeContext(options: { sidebar?: boolean } = {}) {
  const disposers: (() => unknown)[] = []
  const registrations: Registration[] = []
  const tabTypes: { id: string; kind: string; title: () => string; guide?: { id: string; order: number }[] }[] = []
  const live = { bodies: 0, types: 0 }
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
  let snapshot: { status: string; value: unknown } = { status: 'loading', value: undefined }
  const listeners = new Set<() => void>()
  const form = {
    getSnapshot: vi.fn(() => snapshot),
    subscribe: vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  const setElements = (elements: Record<string, boolean>) => {
    snapshot = { status: 'ready', value: { elements } }
    for (const listener of [...listeners]) listener()
  }
  const ctx = {
    remote,
    configForms: { get: vi.fn(() => form) },
    locale: { register: vi.fn(() => () => {}), bind: () => (key: string) => key },
    sidebarRightTabs: {
      register: (definition: (typeof tabTypes)[number]) => {
        tabTypes.push(definition)
        live.types += 1
        return () => { live.types -= 1 }
      },
    },
    slots: {
      inject: (name: string, register: () => () => void) => { injected.push(name); disposers.push(register()) },
      register: (options: Registration) => {
        registrations.push(options)
        if (options.name === 'sidebar.right.pane.tab') live.bodies += 1
        return () => { if (options.name === 'sidebar.right.pane.tab') live.bodies -= 1 }
      },
    },
    effect: (fn: () => unknown) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose as () => unknown) },
    inject: (deps: string[], fn: (scope: unknown) => void) => {
      const present = (dep: string) => dep !== 'sidebarRightTabs' || options.sidebar !== false
      if (deps.every(present)) fn(ctx)
    },
  }
  return { ctx, registrations, tabTypes, live, setElements, injected, disposers, remote, stream, tally, form, accepted }
}

afterEach(() => { vi.restoreAllMocks() })

describe('dsh-tally-ui browser plugin', () => {
  it('needs the config forms service', () => {
    expect(inject).toContain('configForms')
  })

  it('registers one element in each conversation slot with the documented ids', async () => {
    const { ctx, registrations } = fakeContext()
    await apply(ctx as never)
    const byName = Object.fromEntries(registrations.filter(r => r.id !== undefined).map(r => [r.name, r.id]))
    expect(byName).toEqual({
      'conversation.composer.dock': 'tally.dock',
      'conversation.chat.turnTail': 'tally.turn',
      'conversation.session.header.utilities': 'tally.total',
      'shell.overlay': 'tally.budget',
      'settings.section': 'tally',
    })
    expect(registrations).toHaveLength(6)
    expect(registrations.find(r => r.name === 'settings.section')).toMatchObject({ order: 50 })
    expect(registrations.every(r => r.locale === 'tally')).toBe(true)
  })

  it('registers the dashboard tab type and its body, and withdraws both when the switch goes off', async () => {
    const { ctx, registrations, tabTypes, live, setElements } = fakeContext()
    await apply(ctx as never)
    expect(inject).not.toContain('sidebarRightTabs')
    expect(tabTypes).toHaveLength(1)
    expect(tabTypes[0]).toMatchObject({ id: 'tally.dashboard', kind: 'tally.dashboard', guide: [{ id: 'tally.dashboard', order: 50 }] })
    expect(tabTypes[0]!.title()).toBe('tab.title')
    const body = registrations.find(r => r.name === 'sidebar.right.pane.tab')!
    expect(body).toMatchObject({ key: 'tally.dashboard', locale: 'tally' })
    expect(live).toEqual({ bodies: 1, types: 1 })

    setElements({ sidebarTab: false })
    expect(live).toEqual({ bodies: 0, types: 0 })
    setElements({ sidebarTab: true })
    expect(live).toEqual({ bodies: 1, types: 1 })
  })

  it('keeps the conversation elements when the host has no right sidebar', async () => {
    const { ctx, registrations, live } = fakeContext({ sidebar: false })
    await apply(ctx as never)
    expect(registrations.map(r => r.id).filter(Boolean).sort()).toEqual(['tally', 'tally.budget', 'tally.dock', 'tally.total', 'tally.turn'])
    expect(live).toEqual({ bodies: 0, types: 0 })
  })

  it('never registers the dashboard tab when its switch is off from the start', async () => {
    const { ctx, live, setElements } = fakeContext()
    setElements({ sidebarTab: false })
    await apply(ctx as never)
    expect(live).toEqual({ bodies: 0, types: 0 })
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
