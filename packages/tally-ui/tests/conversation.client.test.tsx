// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BalanceSnapshot, BandView, BudgetAlert, CatalogView, SessionView, TallyEntry, TallyStatusView, TurnUsage, UsageGroup } from 'dsh-tally-api'
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
  usage: { backfill: null, errors: [] }, catalogVersion: 'v1', pricingErrors: [], budgetErrors: [], balanceRoutes: ['deepseek'],
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
} = {}) {
  return {
    useElements: hookOf(observable<Elements>({ ...ALL_ELEMENTS, ...opts.elements })),
    useSession: hookOf(observable<SessionView | null>(opts.session === undefined ? sessionView(group([cny('1.5')])) : opts.session)),
    useToday: hookOf(observable<UsageGroup | null>(opts.today === undefined ? group([cny('3')]) : opts.today)),
    useBalances: hookOf(observable<Readonly<Record<string, BalanceSnapshot>>>(opts.balances ?? {})),
    useStatus: hookOf(observable<TallyStatusView | null>(statusView)),
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
  it('shows "unpriced" for an amount that has no price', async () => {
    render(<CostDock {...dockProps({ session: sessionView(group([], { unpricedCount: 2 })) })} />)
    await settle()
    expect(document.querySelector('[data-tally="session"]')?.textContent).toContain(zh['money.unpriced'])
  })

  it('shows why a balance never loaded and never a zero', async () => {
    const props = dockProps({
      today: group([], { requestCount: 0 }),
      balances: { deepseek: balance({ error: 'no key', errorCode: 'not-configured' }) },
    })
    render(<CostDock {...props} />)
    await settle()
    expect(document.querySelector('[data-tally="balance"]')?.textContent).toContain(zh['balance.notConfigured'])
    expect(document.body.textContent).not.toContain('¥0')
  })

  it('marks a stale balance', async () => {
    render(<CostDock {...dockProps({
      balances: { deepseek: balance({ wallets: [{ kind: 'total', money: cny('12.5') }], stale: true, error: 'timeout', errorCode: 'timeout' }) },
    })} />)
    await settle()
    const text = document.querySelector('[data-tally="balance"]')?.textContent
    expect(text).toContain('¥12.5')
    expect(text).toContain(zh['balance.stale'])
  })

  it('refreshes the balance on click and shows a loading state meanwhile', async () => {
    const props = dockProps({ balances: { deepseek: balance({ wallets: [{ kind: 'total', money: cny('12.5') }] }) } })
    let finish!: () => void
    props.refreshBalance.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    render(<CostDock {...props} />)
    await settle()
    const button = document.querySelector('[data-tally="balance"]')!
    fireEvent.click(button)
    expect(props.refreshBalance).toHaveBeenCalledWith('deepseek')
    expect(button.getAttribute('aria-busy')).toBe('true')
    await act(async () => { finish() })
    await settle()
    expect(button.getAttribute('aria-busy')).toBe('false')
  })

  it('counts the band countdown down once a second', async () => {
    const band = vi.fn(async () => ({ band: 'peak' as const, until: Date.now() + 3_600_000, holidayCalendarMissing: false }))
    render(<CostDock {...dockProps({ band })} />)
    await settle()
    expect(band).toHaveBeenCalledWith({ route: 'deepseek', model: 'deepseek-chat', at: Date.now() })
    expect(document.querySelector('[data-tally="band"]')?.textContent).toContain('1:00:00')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(document.querySelector('[data-tally="band"]')?.textContent).toContain('0:59:59')
  })

  it('asks for the band again when the countdown reaches zero', async () => {
    const band = vi.fn(async () => ({ band: 'peak' as const, until: Date.now() + 2000, holidayCalendarMissing: false }))
    render(<CostDock {...dockProps({ band })} />)
    await settle()
    expect(band).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(band).toHaveBeenCalledTimes(2)
  })

  it('shows only today and the balance while the session has no entries', async () => {
    const band = vi.fn(async () => null)
    render(<CostDock {...dockProps({
      session: null, band, balances: { deepseek: balance({ wallets: [{ kind: 'total', money: cny('9') }] }) },
    })} />)
    await settle()
    expect(document.querySelector('[data-tally="session"]')).toBeNull()
    expect(document.querySelector('[data-tally="band"]')).toBeNull()
    expect(document.querySelector('[data-tally="today"]')?.textContent).toContain('¥3')
    expect(document.querySelector('[data-tally="balance"]')?.textContent).toContain('¥9')
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
  return {
    turn: turnLocation,
    sessionId: 's1',
    useElements: hookOf(observable<Elements>({ ...ALL_ELEMENTS, ...extra.elements })),
    useToday: hookOf(observable<UsageGroup | null>(null)),
    loadTurn: vi.fn(async () => usage),
    catalog: vi.fn(async () => catalogView),
    t,
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
  it('lists each subagent session once expanded', async () => {
    const view = sessionView(group([cny('5')]), [
      { sessionId: 'sub-a', total: group([cny('1.25')]) },
      { sessionId: 'sub-b', total: group([], { unpricedCount: 2 }) },
    ])
    render(<SessionTotal
      useElements={hookOf(observable<Elements>(ALL_ELEMENTS))}
      useSession={hookOf(observable<SessionView | null>(view))}
      t={t}
    />)
    const button = document.querySelector('[data-tally="total"]')!
    expect(button.textContent).toContain('¥5')
    expect(document.querySelector('[data-tally="subagent"]')).toBeNull()
    fireEvent.click(button)
    const rows = [...document.querySelectorAll('[data-tally="subagent"]')].map(row => row.textContent)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('sub-a')
    expect(rows[0]).toContain('¥1.25')
    expect(rows[1]).toContain(zh['money.unpriced'])
  })
})

describe('BudgetToast', () => {
  const alert80: BudgetAlert = { budgetId: 'daily', threshold: 0.8, spent: cny('8.5'), limit: cny('10'), periodStart: 0 }

  it('shows the 80% alert with both amounts and dismisses it when the toast is done', async () => {
    const dismissAlert = vi.fn()
    render(<BudgetToast
      useElements={hookOf(observable<Elements>(ALL_ELEMENTS))}
      useAlerts={hookOf(observable<readonly BudgetAlert[]>([alert80]))}
      dismissAlert={dismissAlert}
      t={t}
    />)
    const text = screen.getByRole('status').textContent
    expect(text).toContain('¥8.5')
    expect(text).toContain('¥10')
    expect(text).toContain('daily')
    fireEvent.click(screen.getByTestId('toast-done'))
    expect(dismissAlert).toHaveBeenCalledWith(alert80)
  })

  it('uses the used-up copy at 100%', () => {
    render(<BudgetToast
      useElements={hookOf(observable<Elements>(ALL_ELEMENTS))}
      useAlerts={hookOf(observable<readonly BudgetAlert[]>([{ ...alert80, threshold: 1, spent: cny('10.2') }]))}
      dismissAlert={vi.fn()}
      t={t}
    />)
    expect(screen.getByRole('status').textContent).toBe(t('alert.reached100', { budget: 'daily', spent: '¥10.2', limit: '¥10' }) + 'done')
  })
})
