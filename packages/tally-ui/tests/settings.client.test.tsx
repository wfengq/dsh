// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Budget, CatalogView, Money, TallyStatusView, UsageGroup } from 'dsh-tally-api'
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
  usage: { backfill, errors: [] }, catalogVersion: 'v1', pricingErrors: [], budgetErrors: [], balanceRoutes: [], routes: [],
})
const workspaceGroup = (key: string): UsageGroup => ({
  key, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: [], requestCount: 1, unpricedCount: 0, unknownUsageCount: 0,
})

function mount(options: {
  overrides?: Partial<FormState>
  elements?: Partial<FormState>
  budgets?: Budget[]
  setBudget?: (b: Budget) => Promise<unknown>
  status?: TallyStatusView | null
  spend?: Record<string, Money>
} = {}) {
  const overrides = fakeForm(options.overrides)
  const elements = fakeForm({ value: { elements: {} }, ...options.elements })
  const status = observable<TallyStatusView | null>(options.status ?? null)
  const generation = observable(1)
  const budgetSpend = observable<Record<string, Money>>(options.spend ?? {})
  const remote = {
    query: vi.fn(async () => ok([workspaceGroup('/w'), workspaceGroup('')])),
    catalog: vi.fn(async () => ok(catalog)),
    budgets: vi.fn(async () => ok(options.budgets ?? [])),
    setBudget: vi.fn(options.setBudget ?? (async () => ok(undefined))),
    removeBudget: vi.fn(async () => ok(undefined)),
    rebuild: vi.fn(async () => ok(undefined)),
  }
  const props = { remote, overridesForm: overrides, elementsForm: elements, status, generation, budgetSpend, close: () => {}, t } as unknown as SectionProps
  const view = render(<Section {...props} />)
  return { overrides, elements, status, generation, remote, ...view }
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
    render(<Section {...({ remote: mounted.remote, overridesForm: mounted.overrides, elementsForm: mounted.elements, status: mounted.status, generation: mounted.generation, budgetSpend: observable({}), close: () => {}, t } as unknown as SectionProps)} />)
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

describe('budgets card', () => {
  async function openAdd() {
    fireEvent.click(await screen.findByRole('button', { name: label('settings.budget.add') }))
    return screen.getByRole('dialog', { name: label('settings.budget.add') })
  }

  it('shows the explanation and an add button when there are no budgets', async () => {
    mount()
    expect(await screen.findByText(label('settings.budget.empty'))).toBeTruthy()
    expect(screen.getByRole('button', { name: label('settings.budget.add') })).toBeTruthy()
  })

  it('shows period · scope, spent / limit and a warn tone at 82%', async () => {
    const budget: Budget = { id: 'b1', period: 'day', scope: {}, limit: { amount: '10', currency: 'CNY' } }
    mount({ budgets: [budget], spend: { b1: { amount: '8.2', currency: 'CNY' } } })
    const row = (await screen.findByText(`${label('settings.budget.day')} · ${label('settings.budget.allWorkspaces')}`)).closest('[data-tally="budget-row"]') as HTMLElement
    expect(within(row).getByText(t('settings.budget.spent', { spent: '¥8.2', limit: '¥10' }))).toBeTruthy()
    const pct = within(row).getByText('82%')
    expect(pct.closest('[data-tone]')?.getAttribute('data-tone')).toBe('warn')
  })

  it('says how much a budget is over past 100%', async () => {
    const budget: Budget = { id: 'b1', period: 'month', scope: { workspaceId: '/w' }, limit: { amount: '100', currency: 'CNY' } }
    mount({ budgets: [budget], spend: { b1: { amount: '102', currency: 'CNY' } } })
    expect(await screen.findByText(`${label('settings.budget.month')} · /w`)).toBeTruthy()
    const over = screen.getByText(t('settings.budget.over', { amount: '¥2' }))
    expect(over.closest('[data-tone]')?.getAttribute('data-tone')).toBe('over')
  })

  it('adds a monthly budget for a picked workspace through the dialog and closes it', async () => {
    const view = mount()
    const dialog = await openAdd()
    fireEvent.click(within(dialog).getByRole('tab', { name: label('settings.budget.month') }))
    fireEvent.click(within(dialog).getByRole('button', { name: label('settings.budget.allWorkspaces') }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '/w' }))
    fireEvent.change(within(dialog).getByLabelText(label('settings.budget.amount')), { target: { value: '20' } })
    fireEvent.click(within(dialog).getByRole('button', { name: label('settings.save') }))
    await waitFor(() => { expect(view.remote.setBudget).toHaveBeenCalledTimes(1) })
    expect(view.remote.setBudget).toHaveBeenCalledWith({
      id: expect.stringMatching(/.+/), period: 'month', scope: { workspaceId: '/w' }, limit: { amount: '20', currency: 'CNY' },
    })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('keeps save disabled and explains an invalid amount', async () => {
    mount()
    const dialog = await openAdd()
    fireEvent.change(within(dialog).getByLabelText(label('settings.budget.amount')), { target: { value: '1.234' } })
    expect((within(dialog).getByRole('button', { name: label('settings.save') }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(dialog).getByText(label('settings.budget.invalidAmount'))).toBeTruthy()
  })

  it('refuses a duplicate period and scope', async () => {
    mount({ budgets: [{ id: 'b1', period: 'day', scope: {}, limit: { amount: '10', currency: 'CNY' } }] })
    const dialog = await openAdd()
    fireEvent.change(within(dialog).getByLabelText(label('settings.budget.amount')), { target: { value: '5' } })
    expect(within(dialog).getByText(label('settings.budget.duplicate'))).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: label('settings.save') }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the dialog open and shows the server message on failure', async () => {
    mount({ setBudget: async () => fail('tally/invalid-budget', 'limit must be positive') })
    const dialog = await openAdd()
    fireEvent.change(within(dialog).getByLabelText(label('settings.budget.amount')), { target: { value: '5' } })
    fireEvent.click(within(dialog).getByRole('button', { name: label('settings.save') }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('limit must be positive')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('edits a budget under its own id and deletes one from the ⋯ menu', async () => {
    const budget: Budget = { id: 'b1', period: 'day', scope: {}, limit: { amount: '10', currency: 'CNY' } }
    const view = mount({ budgets: [budget] })
    const row = (await screen.findByText(`${label('settings.budget.day')} · ${label('settings.budget.allWorkspaces')}`)).closest('[data-tally="budget-row"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: label('settings.more') }))
    fireEvent.click(await screen.findByRole('menuitem', { name: label('settings.budget.edit') }))
    const dialog = screen.getByRole('dialog', { name: label('settings.budget.edit') })
    expect((within(dialog).getByLabelText(label('settings.budget.amount')) as HTMLInputElement).value).toBe('10')
    fireEvent.change(within(dialog).getByLabelText(label('settings.budget.amount')), { target: { value: '12' } })
    fireEvent.click(within(dialog).getByRole('button', { name: label('settings.save') }))
    await waitFor(() => { expect(view.remote.setBudget).toHaveBeenCalledWith({ id: 'b1', period: 'day', scope: {}, limit: { amount: '12', currency: 'CNY' } }) })
    fireEvent.click(within(row).getByRole('button', { name: label('settings.more') }))
    fireEvent.click(await screen.findByRole('menuitem', { name: label('settings.remove') }))
    await waitFor(() => { expect(view.remote.removeBudget).toHaveBeenCalledWith({ id: 'b1' }) })
  })
})

describe('element switches', () => {
  it('describes what each switch controls', async () => {
    mount()
    for (const hint of [
      '显示今日、本月费用和预算进度',
      '在每轮回复末尾显示本轮费用',
      '在会话标题旁显示本会话累计',
      '在右侧栏显示用量看板',
      '预算用到 80% 和 100% 时弹出提醒',
    ]) expect(await screen.findByText(hint)).toBeTruthy()
  })

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
    render(<Section {...({ remote: { ...remote, query: vi.fn(async () => ok([])) }, overridesForm: new ClassForm(), elementsForm: new ClassForm(), status, generation: observable(1), budgetSpend: observable({}), close: () => {}, t } as unknown as SectionProps)} />)
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

describe('problems', () => {
  const withProblems = (patch: Partial<TallyStatusView>, usageErrors: TallyStatusView['usage']['errors'] = []): TallyStatusView => ({
    ...statusView(null), usage: { backfill: null, errors: usageErrors }, ...patch,
  })

  it('renders nothing without problems', async () => {
    mount({ status: statusView(null) })
    await screen.findByText(t('settings.catalogVersion', { version: catalog.version }))
    expect(document.querySelector('[data-tally="problems"]')).toBeNull()
  })

  it('lists session, ledger, pricing and budget problems, with a rebuild hint for ledger errors', async () => {
    mount({
      status: withProblems(
        { pricingErrors: ['override for "acme" ignored'], budgetErrors: ['budget file: unsupported budget file format'] },
        [{ sessionId: 's-9', message: 'unsupported log version' }, { message: 'database disk image is malformed' }],
      ),
    })
    const items = [...document.querySelectorAll('[data-tally="problem"]')].map(n => n.textContent)
    expect(items).toEqual([
      t('settings.problem.item', { source: t('settings.problem.session', { session: 's-9' }), message: 'unsupported log version' }),
      t('settings.problem.item', { source: zh['settings.problem.usage'], message: 'database disk image is malformed' }),
      t('settings.problem.item', { source: zh['settings.problem.pricing'], message: 'override for "acme" ignored' }),
      t('settings.problem.item', { source: zh['settings.problem.budget'], message: 'budget file: unsupported budget file format' }),
    ])
    expect(document.querySelector('[data-tally="rebuild-hint"]')?.textContent).toBe(zh['settings.problem.rebuildHint'])
  })

  it('gives no rebuild hint for session-only problems and drops problems once fixed', async () => {
    const view = mount({ status: withProblems({ budgetErrors: ['budget file: bad'] }, [{ sessionId: 's-1', message: 'x' }]) })
    expect(document.querySelectorAll('[data-tally="problem"]')).toHaveLength(2)
    expect(document.querySelector('[data-tally="rebuild-hint"]')).toBeNull()
    act(() => { view.status.set(statusView(null)) })
    expect(document.querySelector('[data-tally="problems"]')).toBeNull()
  })
})

describe('hello generation', () => {
  it('reads the catalog and the budgets again on a new hello', async () => {
    const view = mount()
    await screen.findByText(t('settings.catalogVersion', { version: catalog.version }))
    await waitFor(() => { expect(view.remote.budgets).toHaveBeenCalledTimes(1) })
    expect(view.remote.catalog).toHaveBeenCalledTimes(1)
    view.remote.catalog.mockImplementation(async () => ok({ ...catalog, version: '2026-11-01' }))
    act(() => { view.generation.set(2) })
    await screen.findByText(t('settings.catalogVersion', { version: '2026-11-01' }))
    expect(view.remote.catalog).toHaveBeenCalledTimes(2)
    await waitFor(() => { expect(view.remote.budgets).toHaveBeenCalledTimes(2) })
  })
})
