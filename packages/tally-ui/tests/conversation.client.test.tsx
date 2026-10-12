// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BalanceSnapshot, BandView, Budget, BudgetAlert, CatalogView, SessionView, TallyEntry, TallyStatusView, TurnUsage, UsageGroup } from 'dsh-tally-api'
import { BudgetToast } from '../src/client/BudgetToast.tsx'
import { CostDock } from '../src/client/CostDock.tsx'
import { type Elements, ALL_ELEMENTS } from '../src/client/elements.ts'
import { zh } from '../src/client/locales.ts'
import { SessionTotal } from '../src/client/SessionTotal.tsx'
import { TurnCost } from '../src/client/TurnCost.tsx'
import { hookOf, observable } from './support/hooks.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./support/primitives.tsx'))

const t = (key: keyof typeof zh, params?: Record<string, unknown>) =>
  zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))

const tokens = { input: 900, cacheRead: 100, cacheWrite: 0, output: 50 }
const group = (cost: UsageGroup['cost'], extra: Partial<UsageGroup> = {}): UsageGroup => ({
  key: 'k', tokens, cost, requestCount: 2, unpricedCount: 0, unknownUsageCount: 0, ...extra,
})
const sessionView = (total: UsageGroup, children: SessionView['usage']['children'] = []): SessionView => ({
  usage: { sessionId: 's1', total, children }, lastRoute: 'deepseek', lastModel: 'deepseek-chat',
})
const statusView: TallyStatusView = {
  usage: { backfill: null, errors: [] }, catalogVersion: 'v1', pricingErrors: [], budgetErrors: [], balanceRoutes: ['deepseek'], routes: [],
}
const balance = (extra: Partial<BalanceSnapshot>): BalanceSnapshot => ({
  provider: 'deepseek', wallets: [], fetchedAt: 1, stale: false, ...extra,
})
const cny = (amount: string) => ({ amount, currency: 'CNY' as const })

function dockProps(opts: {
  elements?: Partial<Elements>
  session?: SessionView | null
  today?: UsageGroup | null
  balances?: Record<string, BalanceSnapshot>
  band?: (request: { route: string; model: string; at: number }) => Promise<BandView | null>
  month?: UsageGroup | null
  budgets?: Budget[] | null
  spend?: Record<string, { amount: string; currency: 'CNY' | 'USD' }>
  status?: TallyStatusView
  canOpen?: boolean
} = {}) {
  return {
    useMonth: hookOf(observable<UsageGroup | null>(opts.month === undefined ? group([cny('20')]) : opts.month)),
    useBudgets: hookOf(observable<readonly Budget[] | null>(opts.budgets ?? [])),
    useBudgetSpend: hookOf(observable<Readonly<Record<string, { amount: string; currency: 'CNY' | 'USD' }>>>(opts.spend ?? {})),
    openDashboard: vi.fn(),
    canOpenDashboard: () => opts.canOpen ?? true,
    useElements: hookOf(observable<Elements>({ ...ALL_ELEMENTS, ...opts.elements })),
    useSession: hookOf(observable<SessionView | null>(opts.session === undefined ? sessionView(group([cny('1.5')])) : opts.session)),
    useToday: hookOf(observable<UsageGroup | null>(opts.today === undefined ? group([cny('3')]) : opts.today)),
    useBalances: hookOf(observable<Readonly<Record<string, BalanceSnapshot>>>(opts.balances ?? {})),
    useStatus: hookOf(observable<TallyStatusView | null>(opts.status ?? statusView)),
    refreshBalance: vi.fn(async () => {}),
    band: opts.band ?? (async () => null),
    t,
  }
}

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.UTC(2026, 9, 11, 3, 0, 0))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('CostDock', () => {
  const hover = () => { fireEvent.mouseEnter(screen.getByTestId('hover-anchor')) }
  const order = () => [...document.querySelectorAll('[data-tally="dock"] [data-tally-item]')].map(n => n.getAttribute('data-tally-item'))
  const daily: Budget = { id: 'd', period: 'day', scope: {}, limit: cny('10') }
  const monthly: Budget = { id: 'm', period: 'month', scope: {}, limit: cny('100') }

  it('shows today, month, budget and band in that order, without session or balance', async () => {
    const band = vi.fn(async () => ({ band: 'offpeak' as const, until: Date.now() + 3_600_000, holidayCalendarMissing: false }))
    render(<CostDock {...dockProps({ band, budgets: [daily], spend: { d: cny('3.2') } })} />)
    await settle()
    expect(order()).toEqual(['today', 'month', 'budget', 'band'])
    expect(document.querySelector('[data-tally-item="today"]')?.textContent).toContain('¥3')
    expect(document.querySelector('[data-tally-item="month"]')?.textContent).toContain('¥20')
    expect(document.querySelector('[data-tally-item="budget"]')?.textContent).toContain('32%')
    expect(document.querySelector('[data-tally-item="band"] [data-state-dot]')?.getAttribute('data-state-dot')).toBe('done')
    expect(document.querySelector('[data-tally-item="session"]')).toBeNull()
    expect(document.querySelector('[data-tally="balance"]')).toBeNull()
  })

  it('shows the budget closest to its limit with its tone, and "已超预算" past 100%', async () => {
    render(<CostDock {...dockProps({ budgets: [daily, monthly], spend: { d: cny('1'), m: cny('102') } })} />)
    await settle()
    const item = document.querySelector('[data-tally-item="budget"]')!
    expect(item.getAttribute('data-tone')).toBe('over')
    expect(item.textContent).toContain(t('dock.budgetOver', { amount: '¥2' }))
  })

  it('has no budget item without budgets', async () => {
    render(<CostDock {...dockProps()} />)
    await settle()
    expect(document.querySelector('[data-tally-item="budget"]')).toBeNull()
  })

  it('marks a peak band with a warning dot', async () => {
    const band = vi.fn(async () => ({ band: 'peak' as const, until: Date.now() + 3_600_000, holidayCalendarMissing: false }))
    render(<CostDock {...dockProps({ band })} />)
    await settle()
    expect(document.querySelector('[data-tally-item="band"] [data-state-dot]')?.getAttribute('data-state-dot')).toBe('warning')
  })

  it('lists session, today, month, budgets and the balance in the hover card', async () => {
    render(<CostDock {...dockProps({ budgets: [daily], spend: { d: cny('3.2') }, balances: { deepseek: balance({ wallets: [{ kind: 'total', money: cny('9') }] }) } })} />)
    await settle()
    hover()
    const card = screen.getByTestId('hover-card')
    expect(card.querySelector('[data-tally="session"]')?.textContent).toContain('¥1.5')
    expect(card.querySelector('[data-tally="today"]')?.textContent).toContain('¥3')
    expect(card.querySelector('[data-tally="month"]')?.textContent).toContain('¥20')
    expect(card.querySelector('[data-tally="budget-line"]')?.textContent).toContain(t('settings.budget.spent', { spent: '¥3.2', limit: '¥10' }))
    expect(card.querySelector('[data-tally="balance"]')?.textContent).toContain('¥9')
    expect(card.textContent).toContain(zh['dock.openDashboard'])
  })

  it('opens the same details for keyboard focus, with the balance refresh reachable, and closes on Escape', async () => {
    const props = dockProps({ balances: { deepseek: balance({ wallets: [{ kind: 'total', money: cny('9') }] }) } })
    render(<CostDock {...props} />)
    await settle()
    const bar = screen.getByRole('button', { name: new RegExp(zh['dock.today']) })
    fireEvent.focus(bar)
    const panel = screen.getByRole('dialog', { name: zh['dock.details'] })
    expect(panel.querySelector('[data-tally="balance"]')?.textContent).toContain('¥9')
    fireEvent.click(panel.querySelector('[data-tally="balance"]')!)
    expect(props.refreshBalance).toHaveBeenCalledWith('deepseek')
    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: zh['dock.details'] })).toBeNull()
  })

  it('does not open the keyboard panel for the focus that follows a click', async () => {
    render(<CostDock {...dockProps()} />)
    await settle()
    const bar = screen.getByRole('button', { name: new RegExp(zh['dock.today']) })
    fireEvent.pointerDown(bar)
    fireEvent.focus(bar)
    expect(screen.queryByRole('dialog', { name: zh['dock.details'] })).toBeNull()
  })

  it('offers no way to the dashboard while it cannot open', async () => {
    const props = dockProps({ canOpen: false })
    render(<CostDock {...props} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(zh['dock.today']) }))
    expect(props.openDashboard).not.toHaveBeenCalled()
    fireEvent.mouseEnter(screen.getByTestId('hover-anchor'))
    expect(screen.queryByText(zh['dock.openDashboard'])).toBeNull()
  })

  it('opens the dashboard when the bar is clicked', async () => {
    const props = dockProps()
    render(<CostDock {...props} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(zh['dock.today']) }))
    expect(props.openDashboard).toHaveBeenCalledWith()
  })

  it('shows "unpriced" for an amount that has no price, never ¥0', async () => {
    render(<CostDock {...dockProps({ today: group([], { unpricedCount: 2 }), month: group([], { unpricedCount: 2 }) })} />)
    await settle()
    expect(document.querySelector('[data-tally-item="today"]')?.textContent).toContain(zh['money.unpriced'])
    expect(document.body.textContent).not.toContain('¥0')
  })

  it('shows why a balance never loaded and never a zero', async () => {
    render(<CostDock {...dockProps({ today: group([], { requestCount: 0 }), month: group([], { requestCount: 0 }), balances: { deepseek: balance({ error: 'no key', errorCode: 'not-configured' }) } })} />)
    await settle()
    hover()
    expect(document.querySelector('[data-tally="balance"]')?.textContent).toContain(zh['balance.notConfigured'])
    expect(document.body.textContent).not.toContain('¥0')
  })

  it('refreshes the balance from the hover card', async () => {
    const props = dockProps({ balances: { deepseek: balance({ wallets: [{ kind: 'total', money: cny('12.5') }] }) } })
    render(<CostDock {...props} />)
    await settle()
    hover()
    fireEvent.click(document.querySelector('[data-tally="balance"]')!)
    expect(props.refreshBalance).toHaveBeenCalledWith('deepseek')
    expect(props.openDashboard).not.toHaveBeenCalled()
  })

  it('counts the band countdown down once a second', async () => {
    const band = vi.fn(async () => ({ band: 'peak' as const, until: Date.now() + 3_600_000, holidayCalendarMissing: false }))
    render(<CostDock {...dockProps({ band })} />)
    await settle()
    expect(band).toHaveBeenCalledWith({ route: 'deepseek', model: 'deepseek-chat', at: Date.now() })
    expect(document.querySelector('[data-tally-item="band"]')?.textContent).toContain('1:00:00')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(document.querySelector('[data-tally-item="band"]')?.textContent).toContain('0:59:59')
  })

  it('asks for the band again when the countdown reaches zero', async () => {
    const band = vi.fn(async () => ({ band: 'peak' as const, until: Date.now() + 2000, holidayCalendarMissing: false }))
    render(<CostDock {...dockProps({ band })} />)
    await settle()
    expect(band).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(band).toHaveBeenCalledTimes(2)
  })

  it('renders nothing when the composer dock is switched off', async () => {
    const { container } = render(<CostDock {...dockProps({ elements: { composerDock: false } })} />)
    await settle()
    expect(container.innerHTML).toBe('')
  })
})

const attempt = (extra: Partial<TallyEntry> = {}): TallyEntry => ({
  id: 'e1', sessionId: 's1', rootSessionId: 's1', at: 1, route: 'deepseek', provider: 'deepseek', model: 'deepseek-chat', band: 'peak',
  tokens, cost: cny('0.002'), priceVersion: 'deepseek-2026-09', usageKnown: true, ...extra,
})
const catalogView: CatalogView = {
  version: 'v1',
  providers: [{
    id: 'deepseek', currency: 'CNY',
    models: [{ model: 'deepseek-chat', priceVersion: 'deepseek-2026-09', effectiveFrom: '2026-09-01', source: { url: 'https://example.com/pricing', retrievedAt: '2026-09-02' } }],
  }],
}
const turnLocation = { start: { seq: 4 }, end: { seq: 9 } }

function turnProps(usage: TurnUsage | null, extra: { elements?: Partial<Elements> } = {}) {
  const generation = observable(1)
  const today = observable<UsageGroup | null>(null)
  return {
    turn: turnLocation,
    sessionId: 's1',
    useElements: hookOf(observable<Elements>({ ...ALL_ELEMENTS, ...extra.elements })),
    useToday: hookOf(today),
    useGeneration: hookOf(generation),
    loadTurn: vi.fn(async (_request: { sessionId: string; fromSeq: number; toSeq: number }): Promise<TurnUsage | null> => usage),
    catalog: vi.fn(async () => catalogView),
    t,
    generation,
    today,
  }
}

describe('TurnCost', () => {
  it('asks for the turn by its sequence range and shows hit rate, request count and the price source on hover', async () => {
    const usage: TurnUsage = { total: group([cny('0.004')]), attempts: [attempt(), attempt({ id: 'e2' })] }
    const props = turnProps(usage)
    render(<TurnCost {...props} />)
    await settle()
    expect(props.loadTurn).toHaveBeenCalledWith({ sessionId: 's1', fromSeq: 4, toSeq: 9 })
    expect(document.querySelector('[data-tally="turn"]')?.textContent).toContain('¥0.004')
    fireEvent.mouseEnter(screen.getByTestId('hover-anchor'))
    await settle()
    const card = screen.getByTestId('hover-card')
    expect(card.textContent).toContain(zh['turn.hitRate'])
    expect(card.textContent).toContain('10%')
    expect(card.textContent).toContain(zh['turn.requests'])
    expect(card.querySelector('[data-tally="requests"]')?.textContent).toBe('2')
    const link = card.querySelector('a[data-tally="price-source"]')
    expect(link?.getAttribute('href')).toBe('https://example.com/pricing')
    expect(link?.textContent).toBe('deepseek-2026-09')
  })

  it('asks again on every hello and shows the new price of a turn that had entries', async () => {
    const props = turnProps({ total: group([cny('0.004')]), attempts: [attempt()] })
    render(<TurnCost {...props} />)
    await settle()
    expect(document.querySelector('[data-tally="turn"]')?.textContent).toContain('¥0.004')
    expect(props.loadTurn).toHaveBeenCalledTimes(1)
    expect(props.catalog).toHaveBeenCalledTimes(1)
    // Recorded usage elsewhere does not refetch a turn that is already shown.
    act(() => { props.today.set(group([cny('9')])) })
    await settle()
    expect(props.loadTurn).toHaveBeenCalledTimes(1)
    // A hello (say, after a price override was saved and the ledger repriced) does.
    props.loadTurn.mockImplementation(async () => ({ total: group([cny('0.008')]), attempts: [attempt({ cost: cny('0.008'), priceVersion: 'manual:deepseek' })] }))
    act(() => { props.generation.set(2) })
    await settle()
    expect(props.loadTurn).toHaveBeenCalledTimes(2)
    expect(props.catalog).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-tally="turn"]')?.textContent).toContain('¥0.008')
    await settle()
    expect(props.loadTurn).toHaveBeenCalledTimes(2)
  })

  it('keeps asking on recorded usage until the turn has entries', async () => {
    const props = turnProps({ total: group([], { requestCount: 0 }), attempts: [] })
    const { container } = render(<TurnCost {...props} />)
    await settle()
    expect(container.innerHTML).toBe('')
    props.loadTurn.mockImplementation(async () => ({ total: group([cny('0.002')]), attempts: [attempt()] }))
    act(() => { props.today.set(group([cny('1')])) })
    await settle()
    expect(props.loadTurn).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-tally="turn"]')?.textContent).toContain('¥0.002')
  })

  it('renders nothing for a turn without entries', async () => {
    const { container } = render(<TurnCost {...turnProps({ total: group([], { requestCount: 0 }), attempts: [] })} />)
    await settle()
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing for a turn that has not ended', async () => {
    const props = { ...turnProps({ total: group([cny('1')]), attempts: [attempt()] }), turn: { start: { seq: 4 }, end: undefined } }
    const { container } = render(<TurnCost {...props} />)
    await settle()
    expect(props.loadTurn).not.toHaveBeenCalled()
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the turn tail is switched off', async () => {
    const { container } = render(<TurnCost {...turnProps({ total: group([cny('1')]), attempts: [attempt()] }, { elements: { turnTail: false } })} />)
    await settle()
    expect(container.innerHTML).toBe('')
  })
})

describe('SessionTotal', () => {
  const total = (view: SessionView, models: UsageGroup[] = [], openDashboard = vi.fn()) => (
    <SessionTotal
      sessionId="s1"
      useElements={hookOf(observable<Elements>(ALL_ELEMENTS))}
      useSession={hookOf(observable<SessionView | null>(view))}
      loadModels={vi.fn(async () => models)}
      openDashboard={openDashboard}
      canOpenDashboard={() => true}
      t={t}
    />
  )

  it('shows the session total and opens the dashboard on the session when clicked', async () => {
    const openDashboard = vi.fn()
    render(total(sessionView(group([cny('5')])), [], openDashboard))
    const button = document.querySelector('[data-tally="total"]')!
    expect(button.textContent).toContain('¥5')
    fireEvent.click(button)
    expect(openDashboard).toHaveBeenCalledWith('s1')
  })

  it('shows the subagent list to keyboard focus as well', async () => {
    const view = sessionView(group([cny('5')]), [{ sessionId: 'sub-a', total: group([cny('1.25')]) }])
    render(total(view))
    fireEvent.focus(document.querySelector('[data-tally="total"]')!)
    const panel = screen.getByRole('dialog', { name: zh['header.total'] })
    expect(panel.querySelector('[data-tally="subagent"]')?.textContent).toContain('sub-a')
  })

  it('splits the session by model and lists subagents on hover', async () => {
    const view = sessionView(group([cny('5')]), [
      { sessionId: 'sub-a', total: group([cny('1.25')]) },
      { sessionId: 'sub-b', total: group([], { unpricedCount: 2 }) },
    ])
    render(total(view, [{ ...group([cny('4')]), key: 'deepseek-chat' }, { ...group([cny('1')], { requestCount: 3 }), key: 'deepseek-reasoner' }]))
    fireEvent.mouseEnter(screen.getByTestId('hover-anchor'))
    await settle()
    const models = [...document.querySelectorAll('[data-tally="model-row"]')].map(row => row.textContent)
    expect(models[0]).toContain('deepseek-chat')
    expect(models[0]).toContain('¥4')
    expect(models[1]).toContain(t('header.requests', { count: 3 }))
    const rows = [...document.querySelectorAll('[data-tally="subagent"]')].map(row => row.textContent)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('¥1.25')
    expect(rows[1]).toContain(zh['money.unpriced'])
  })
})

describe('BudgetToast', () => {
  const ID = '6f1c2a9e-0d4b-4a51-9f3e-2b7c8d9e0f12'
  const alert80: BudgetAlert = { budgetId: ID, threshold: 0.8, spent: cny('8.2'), limit: cny('10'), periodStart: 0 }
  const daily: Budget = { id: ID, period: 'day', scope: {}, limit: cny('10') }
  const toast = (alerts: readonly BudgetAlert[], budgets: readonly Budget[] | null = [daily], dismissAlert = vi.fn(), openDashboard = vi.fn(), canOpen = true) => (
    <BudgetToast
      useElements={hookOf(observable<Elements>(ALL_ELEMENTS))}
      useAlerts={hookOf(observable<readonly BudgetAlert[]>(alerts))}
      useBudgets={hookOf(observable<readonly Budget[] | null>(budgets))}
      dismissAlert={dismissAlert}
      openDashboard={openDashboard}
      canOpenDashboard={() => canOpen}
      t={t}
    />
  )

  it('reads "今日预算已用 82%（¥8.2 / ¥10）", dismisses when done, and 查看 opens the dashboard', () => {
    const dismissAlert = vi.fn()
    const openDashboard = vi.fn()
    render(toast([alert80], [daily], dismissAlert, openDashboard))
    expect(screen.getByTestId('toast-text').textContent).toBe(t('alert.used', { period: zh['alert.period.day'], pct: 82, spent: '¥8.2', limit: '¥10' }))
    expect(screen.getByRole('status').textContent).not.toContain(ID)
    fireEvent.click(screen.getByRole('button', { name: zh['alert.view'] }))
    expect(openDashboard).toHaveBeenCalledWith()
    fireEvent.click(screen.getByTestId('toast-done'))
    expect(dismissAlert).toHaveBeenCalledWith(alert80)
  })

  it('has no 查看 action while the dashboard cannot open', () => {
    render(toast([alert80], [daily], vi.fn(), vi.fn(), false))
    expect(screen.queryByRole('button', { name: zh['alert.view'] })).toBeNull()
  })

  it('reads naturally in English for a budget it does not know', async () => {
    const { en } = await import('../src/client/locales.ts')
    const tEn = (key: keyof typeof en, params?: Record<string, unknown>) => en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
    render(<BudgetToast
      useElements={hookOf(observable<Elements>(ALL_ELEMENTS))}
      useAlerts={hookOf(observable<readonly BudgetAlert[]>([alert80]))}
      useBudgets={hookOf(observable<readonly Budget[] | null>(null))}
      dismissAlert={vi.fn()}
      openDashboard={vi.fn()}
      canOpenDashboard={() => true}
      t={tEn as never}
    />)
    expect(screen.getByTestId('toast-text').textContent).toMatch(/^The budget 82% used/)
  })

  it('says a monthly workspace budget is over at 100%', () => {
    const monthly: Budget = { id: ID, period: 'month', scope: { workspaceId: 'ws-a' }, limit: cny('100') }
    render(toast([{ ...alert80, threshold: 1, spent: cny('102'), limit: cny('100') }], [monthly]))
    expect(screen.getByTestId('toast-text').textContent).toBe(t('alert.over', { period: `${zh['alert.period.month']}（ws-a）`, spent: '¥102', limit: '¥100' }))
  })

  it('falls back to a period-less name for a budget it does not know', () => {
    render(toast([alert80], null))
    expect(screen.getByTestId('toast-text').textContent).toBe(t('alert.used', { period: zh['alert.period.any'], pct: 82, spent: '¥8.2', limit: '¥10' }))
  })
})
