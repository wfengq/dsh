// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Budget, CatalogView, TallyStatusView } from 'dsh-tally-api'
import { en, zh } from '../src/client/locales.ts'
import { Section, type SectionProps } from '../src/client/settings/Section.tsx'
import { observable } from './support/hooks.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./support/primitives.tsx'))

const t = (key: keyof typeof zh, params?: Record<string, unknown>) =>
  zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))

afterEach(cleanup)

const ok = <T,>(value: T) => ({ ok: true as const, value })
const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message } })

const catalog: CatalogView = {
  version: '2026-10-01',
  providers: [{
    id: 'deepseek',
    currency: 'CNY',
    models: [{ model: 'deepseek-chat', priceVersion: 'v7', effectiveFrom: '2026-09-01', source: { url: 'https://example.test/pricing', retrievedAt: '2026-10-01' } }],
  }],
}

interface FormState {
  status: 'loading' | 'ready' | 'unavailable'
  value: unknown
  writable: boolean
  mode: 'host' | 'memory'
  revision: number | undefined
}

function fakeForm(patch: Partial<FormState> = {}) {
  const state = observable<FormState>({ status: 'ready', value: {}, writable: true, mode: 'host', revision: 1, ...patch })
  return { ...state, mutate: vi.fn(async (_ops: ReadonlyArray<{ op: 'set'; path: string[]; value: unknown }>) => true) }
}

/** The single-op mutation a field write sends. */
const setOp = (path: string[], value: unknown) => [{ op: 'set', path, value }]

const statusView = (backfill: { done: number; total: number } | null): TallyStatusView => ({
  usage: { backfill, errors: [] }, catalogVersion: 'v1', pricingErrors: [], budgetErrors: [], balanceRoutes: [],
})

function mount(options: {
  overrides?: Partial<FormState>
  elements?: Partial<FormState>
  budgets?: Budget[]
  setBudget?: (b: Budget) => Promise<unknown>
  status?: TallyStatusView | null
} = {}) {
  const overrides = fakeForm(options.overrides)
  const elements = fakeForm({ value: { elements: {} }, ...options.elements })
  const status = observable<TallyStatusView | null>(options.status ?? null)
  const remote = {
    catalog: vi.fn(async () => ok(catalog)),
    budgets: vi.fn(async () => ok(options.budgets ?? [])),
    setBudget: vi.fn(options.setBudget ?? (async () => ok(undefined))),
    removeBudget: vi.fn(async () => ok(undefined)),
    rebuild: vi.fn(async () => ok(undefined)),
  }
  const props = { remote, overridesForm: overrides, elementsForm: elements, status, close: () => {}, t } as unknown as SectionProps
  const view = render(<Section {...props} />)
  return { overrides, elements, status, remote, ...view }
}

const label = (key: keyof typeof zh) => zh[key]

describe('dictionaries', () => {
  it('keeps the settings keys in both languages', () => {
    for (const key of Object.keys(zh)) expect(en).toHaveProperty(key)
  })
})

describe('catalog info', () => {
  it('shows the data version, per-model price version, effective date, source link and the disclaimer', async () => {
    mount()
    expect(await screen.findByText(t('settings.catalogVersion', { version: '2026-10-01' }))).toBeTruthy()
    expect(screen.getByText('deepseek-chat')).toBeTruthy()
    expect(screen.getByText('v7')).toBeTruthy()
    expect(screen.getByText('2026-09-01')).toBeTruthy()
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.test/pricing')
    expect(screen.getByText(zh.disclaimer)).toBeTruthy()
  })
})

describe('catalog source links', () => {
  it('renders a non-http(s) source as text, never as a link', async () => {
    const mounted = mount()
    mounted.remote.catalog.mockResolvedValue(ok({
      ...catalog,
      providers: [{ ...catalog.providers[0]!, models: [{ ...catalog.providers[0]!.models[0]!, source: { url: 'javascript:alert(1)', retrievedAt: 'x' } }] }],
    }))
    cleanup()
    render(<Section {...({ remote: mounted.remote, overridesForm: mounted.overrides, elementsForm: mounted.elements, status: mounted.status, close: () => {}, t } as unknown as SectionProps)} />)
    await screen.findByText('deepseek-chat')
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('overrides editor', () => {
  async function openManual(view: ReturnType<typeof mount>) {
    fireEvent.click(await screen.findByRole('tab', { name: label('settings.override.manual') }))
    fireEvent.change(screen.getByLabelText(label('settings.override.route')), { target: { value: 'my-proxy' } })
    fireEvent.change(screen.getByLabelText(label('settings.override.model')), { target: { value: 'm1' } })
    fireEvent.change(screen.getByLabelText(label('settings.override.rateOutput')), { target: { value: '2' } })
    return view
  }

  it('enables save only for a plain decimal rate and writes the override', async () => {
    const view = mount()
    await openManual(view)
    const rate = screen.getByLabelText(label('settings.override.rateInput'))
    const save = screen.getByRole('button', { name: label('settings.save') }) as HTMLButtonElement
    fireEvent.change(rate, { target: { value: '1.5e-3' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(rate, { target: { value: '0.0015' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => { expect(view.overrides.mutate).toHaveBeenCalledTimes(1) })
    expect(view.overrides.mutate).toHaveBeenCalledWith(setOp(['overrides'], [
      { provider: 'my-proxy', kind: 'manual', currency: 'CNY', models: { m1: { input: '0.0015', output: '2' } } },
    ]))
  })

  it('rejects more than twelve fraction digits', async () => {
    const view = mount()
    await openManual(view)
    fireEvent.change(screen.getByLabelText(label('settings.override.rateInput')), { target: { value: '0.1234567890123' } })
    expect((screen.getByRole('button', { name: label('settings.save') }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('adds an alias override next to the existing ones and removes one', async () => {
    const existing = { provider: 'old', kind: 'alias', target: { provider: 'deepseek' } }
    const view = mount({ overrides: { value: { overrides: [existing] } } })
    fireEvent.change(await screen.findByLabelText(label('settings.override.route')), { target: { value: 'proxy' } })
    fireEvent.change(screen.getByLabelText(label('settings.override.targetProvider')), { target: { value: 'deepseek' } })
    fireEvent.change(screen.getByLabelText(label('settings.override.targetModel')), { target: { value: 'deepseek-chat' } })
    fireEvent.click(screen.getByRole('button', { name: label('settings.save') }))
    await waitFor(() => { expect(view.overrides.mutate).toHaveBeenCalledTimes(1) })
    expect(view.overrides.mutate).toHaveBeenCalledWith(setOp(['overrides'], [existing, { provider: 'proxy', kind: 'alias', target: { provider: 'deepseek', model: 'deepseek-chat' } }]))
    fireEvent.click(screen.getAllByRole('button', { name: label('settings.remove') })[0]!)
    await waitFor(() => { expect(view.overrides.mutate).toHaveBeenCalledTimes(2) })
    expect(view.overrides.mutate).toHaveBeenLastCalledWith(setOp(['overrides'], []))
  })

  it('is read-only in memory mode and says why', async () => {
    const view = mount({ overrides: { mode: 'memory', writable: false } })
    expect(await screen.findByText(label('settings.readonly.memory'))).toBeTruthy()
    expect((screen.getByLabelText(label('settings.override.route')) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: label('settings.save') }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.overrides.mutate).not.toHaveBeenCalled()
  })

  it('is read-only when the form is unavailable or not writable', async () => {
    mount({ overrides: { status: 'unavailable' } })
    expect(await screen.findByText(label('settings.readonly.unavailable'))).toBeTruthy()
    cleanup()
    mount({ overrides: { writable: false } })
    expect(await screen.findByText(label('settings.readonly.notWritable'))).toBeTruthy()
  })

  it('reports a refused write', async () => {
    const view = mount()
    await openManual(view)
    fireEvent.change(screen.getByLabelText(label('settings.override.rateInput')), { target: { value: '1' } })
    view.overrides.mutate.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: label('settings.save') }))
    expect(await screen.findByText(label('settings.saveFailed'))).toBeTruthy()
  })
})

describe('budgets editor', () => {
  async function fillBudget() {
    fireEvent.click(await screen.findByRole('tab', { name: label('settings.budget.month') }))
    fireEvent.change(screen.getByLabelText(label('settings.budget.amount')), { target: { value: '100' } })
  }

  it('creates a monthly 100 CNY budget', async () => {
    const view = mount()
    await fillBudget()
    fireEvent.click(screen.getByRole('button', { name: label('settings.budget.add') }))
    await waitFor(() => { expect(view.remote.setBudget).toHaveBeenCalledTimes(1) })
    expect(view.remote.setBudget).toHaveBeenCalledWith({
      id: expect.stringMatching(/.+/), period: 'month', scope: {}, limit: { amount: '100', currency: 'CNY' },
    })
  })

  it('keeps add disabled for a zero or malformed amount', async () => {
    mount()
    await fillBudget()
    const add = screen.getByRole('button', { name: label('settings.budget.add') }) as HTMLButtonElement
    expect(add.disabled).toBe(false)
    fireEvent.change(screen.getByLabelText(label('settings.budget.amount')), { target: { value: '0.00' } })
    expect(add.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(label('settings.budget.amount')), { target: { value: '1e3' } })
    expect(add.disabled).toBe(true)
  })

  it('shows the server message when the budget is refused', async () => {
    mount({ setBudget: async () => fail('tally/invalid-budget', 'limit must be positive') })
    await fillBudget()
    fireEvent.click(screen.getByRole('button', { name: label('settings.budget.add') }))
    expect((await screen.findByRole('alert')).textContent).toContain('limit must be positive')
  })

  it('lists existing budgets and removes one', async () => {
    const budget: Budget = { id: 'b1', period: 'day', scope: { workspaceId: 'w1' }, limit: { amount: '5', currency: 'USD' } }
    const view = mount({ budgets: [budget] })
    const row = await screen.findByText(/w1/)
    fireEvent.click(within(row.closest('li')!).getByRole('button', { name: label('settings.remove') }))
    await waitFor(() => { expect(view.remote.removeBudget).toHaveBeenCalledWith({ id: 'b1' }) })
  })
})

describe('element switches', () => {
  it('writes the switch that was turned off', async () => {
    const view = mount()
    fireEvent.click(await screen.findByRole('switch', { name: label('settings.element.turnTail') }))
    await waitFor(() => { expect(view.elements.mutate).toHaveBeenCalledWith(setOp(['elements', 'turnTail'], false)) })
  })

  it('gives the switches a neutral read-only reason in memory mode', async () => {
    mount({ elements: { mode: 'memory', writable: false } })
    expect(await screen.findByText(label('settings.readonly.memoryGeneric'))).toBeTruthy()
    expect(screen.queryByText(label('settings.readonly.memory'))).toBeNull()
  })

  it('shows a missing switch as on and disables all when not writable', async () => {
    mount({ elements: { writable: false } })
    const toggle = await screen.findByRole('switch', { name: label('settings.element.sidebarTab') }) as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.disabled).toBe(true)
  })

  it('reads a class-based form whose methods depend on `this`, like the host ConfigForm', async () => {
    class ClassForm {
      private readonly store = observable<FormState>({ status: 'ready', value: { elements: { turnTail: false } }, writable: true, mode: 'host', revision: 1 })
      getSnapshot() { return this.store.getSnapshot() }
      subscribe(listener: () => void) { return this.store.subscribe(listener) }
      async mutate() { return true }
    }
    const status = observable<TallyStatusView | null>(null)
    const remote = {
      catalog: vi.fn(async () => ok(catalog)),
      budgets: vi.fn(async () => ok([])),
      setBudget: vi.fn(async () => ok(undefined)),
      removeBudget: vi.fn(async () => ok(undefined)),
      rebuild: vi.fn(async () => ok(undefined)),
    }
    render(<Section {...({ remote, overridesForm: new ClassForm(), elementsForm: new ClassForm(), status, close: () => {}, t } as unknown as SectionProps)} />)
    const toggle = await screen.findByRole('switch', { name: label('settings.element.turnTail') })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })
})

describe('rebuild', () => {
  it('asks first, then rebuilds', async () => {
    const view = mount()
    fireEvent.click(await screen.findByRole('button', { name: label('settings.rebuildAction') }))
    expect(view.remote.rebuild).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: label('settings.confirm') }))
    await waitFor(() => { expect(view.remote.rebuild).toHaveBeenCalledTimes(1) })
  })

  it('does not rebuild when the confirmation is cancelled', async () => {
    const view = mount()
    fireEvent.click(await screen.findByRole('button', { name: label('settings.rebuildAction') }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: label('settings.cancel') }))
    expect(view.remote.rebuild).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stays disabled after the call until a backfill has been seen and finished', async () => {
    const view = mount()
    const button = await screen.findByRole('button', { name: label('settings.rebuildAction') }) as HTMLButtonElement
    fireEvent.click(button)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: label('settings.confirm') }))
    await waitFor(() => { expect(view.remote.rebuild).toHaveBeenCalled() })
    await waitFor(() => { expect(button.disabled).toBe(true) })
    act(() => { view.status.set(statusView({ done: 1, total: 2 })) })
    expect(button.disabled).toBe(true)
    act(() => { view.status.set(statusView(null)) })
    expect(button.disabled).toBe(false)
  })

  it('stops waiting for a status frame after a bounded time', async () => {
    vi.useFakeTimers()
    try {
      const view = mount()
      const button = screen.getByRole('button', { name: label('settings.rebuildAction') }) as HTMLButtonElement
      fireEvent.click(button)
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: label('settings.confirm') }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(view.remote.rebuild).toHaveBeenCalled()
      expect(button.disabled).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
      expect(button.disabled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('disables the button and shows progress while a backfill runs, then recovers', async () => {
    const view = mount({ status: statusView({ done: 3, total: 10 }) })
    const button = await screen.findByRole('button', { name: label('settings.rebuildAction') }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText(t('settings.rebuildProgress', { done: 3, total: 10 }))).toBeTruthy()
    act(() => { view.status.set(statusView({ done: 4, total: 10 })) })
    expect(screen.getByText(t('settings.rebuildProgress', { done: 4, total: 10 }))).toBeTruthy()
    act(() => { view.status.set(statusView(null)) })
    expect(button.disabled).toBe(false)
    expect(screen.queryByText(/正在重建/)).toBeNull()
  })
})
