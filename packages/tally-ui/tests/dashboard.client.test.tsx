// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Budget, Money, PeakSavings, TallyTokens, UsageGroup, UsageQuery } from 'dsh-tally-api'
import { Dashboard } from '../src/client/dashboard/Dashboard.tsx'
import type { DashboardRemote } from '../src/client/dashboard/data.ts'
import { zh } from '../src/client/locales.ts'
import { observable } from './support/hooks.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./support/primitives.tsx'))

const t = (key: keyof typeof zh, params?: Record<string, unknown>) =>
  zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))

const ok = <T,>(value: T) => ({ ok: true as const, value })
const cny = (amount: string) => ({ amount, currency: 'CNY' as const })
const tokens = (input: number, cacheRead: number): TallyTokens => ({ input, cacheRead, cacheWrite: 0, output: 1 })
const group = (key: string, extra: Partial<UsageGroup> = {}): UsageGroup => ({
  key, tokens: tokens(100, 300), cost: [cny('1')], requestCount: 2, unpricedCount: 0, unknownUsageCount: 0, ...extra,
})

const DAY = 24 * 3600 * 1000
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0)

interface Script {
  all?: UsageGroup[]
  peak?: UsageGroup[]
  offpeak?: UsageGroup[]
  flat?: UsageGroup[]
  model?: UsageGroup[]
  workspace?: UsageGroup[]
  session?: UsageGroup[]
  savings?: PeakSavings
  csv?: string
}

/** A scripted remote: answers by grouping and band, and records every request. */
function scriptedRemote(script: Script = {}) {
  const queries: UsageQuery[] = []
  const remote = {
    query: vi.fn(async (q: UsageQuery) => {
      queries.push(q)
      if (q.groupBy === 'day') {
        const rows = q.filter?.band === 'peak' ? script.peak : q.filter?.band === 'offpeak' ? script.offpeak : q.filter?.band === 'flat' ? script.flat : script.all
        return ok(rows ?? [])
      }
      return ok((q.groupBy === 'model' ? script.model : q.groupBy === 'workspace' ? script.workspace : script.session) ?? [])
    }),
    peakSavings: vi.fn(async () => ok(script.savings ?? { peak: [], offpeakEquivalent: [], saving: [] })),
    exportCsv: vi.fn(async () => ok(script.csv ?? 'a,b\n')),
  }
  return { remote: remote as unknown as DashboardRemote & typeof remote, queries }
}

interface Extra {
  params?: { sessionId?: string }
  today?: UsageGroup | null
  month?: UsageGroup | null
  budgets?: Budget[]
  spend?: Record<string, Money>
}

function mount(script: Script = {}, visible = true, prepare?: (remote: ReturnType<typeof scriptedRemote>['remote']) => void, extra: Extra = {}) {
  const fake = scriptedRemote(script)
  prepare?.(fake.remote)
  const useTabInfo = () => ({ tab: { visible, navigation: { address: 'x', params: extra.params, revision: extra.params ? 1 : 0 } } }) as never
  const generation = observable(1)
  const recorded = observable(0)
  const today = observable<UsageGroup | null>(extra.today === undefined ? group('today', { cost: [cny('1.23')] }) : extra.today)
  const month = observable<UsageGroup | null>(extra.month === undefined ? group('month', { cost: [cny('20.1')] }) : extra.month)
  const budgets = observable<readonly Budget[] | null>(extra.budgets ?? [])
  const budgetSpend = observable<Readonly<Record<string, Money>>>(extra.spend ?? {})
  const view = render(<Dashboard remote={fake.remote} generation={generation} recorded={recorded} today={today} month={month} budgets={budgets} budgetSpend={budgetSpend} now={() => NOW} useTabInfo={useTabInfo} t={t} />)
  return { ...fake, ...view, generation, recorded }
}

const openAnalysis = () => { fireEvent.click(screen.getByRole('button', { name: zh['tab.analysis'] })) }
const exportCsv = () => {
  fireEvent.click(screen.getByRole('button', { name: zh['settings.more'] }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh['tab.export'] }))
}
const rankTab = (name: string) => { fireEvent.click(screen.getByRole('tab', { name })) }

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

const ZONE = process.env.TZ
// Whole-day spans are only exact in a zone without DST; pin one for the module.
beforeAll(() => { process.env.TZ = 'UTC' })
afterAll(() => { if (ZONE === undefined) delete process.env.TZ; else process.env.TZ = ZONE })
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('Dashboard', () => {
  it('offers 7 days, 30 days and this month, and loads exactly 7 days by default', async () => {
    const { queries } = mount()
    await settle()
    expect(screen.getAllByRole('tab').map(n => n.textContent).slice(0, 3)).toEqual([zh['tab.range.7d'], zh['tab.range.30d'], zh['tab.range.month']])
    expect(queries.length).toBeGreaterThan(0)
    for (const q of queries) expect(q.to - q.from).toBe(7 * DAY)
  })

  it('selects the other ranges too', async () => {
    const { queries } = mount()
    await settle()
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.range.30d'] }))
    await settle()
    expect(queries.at(-1)!.to - queries.at(-1)!.from).toBe(30 * DAY)
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.range.month'] }))
    await settle()
    expect(queries.at(-1)!.to - queries.at(-1)!.from).toBe(31 * DAY)
  })

  it('queries each day per band and groups the rankings', async () => {
    const { queries } = mount()
    await settle()
    const bands = queries.filter(q => q.groupBy === 'day').map(q => q.filter?.band)
    expect(bands).toEqual(expect.arrayContaining(['peak', 'offpeak']))
    expect(queries.map(q => q.groupBy)).toEqual(expect.arrayContaining(['model', 'workspace', 'session']))
  })

  it('does not load while the tab is hidden', async () => {
    const { remote } = mount({}, false)
    await settle()
    expect(remote.query).not.toHaveBeenCalled()
  })

  it('stacks peak and off-peak (with flat) per currency', async () => {
    mount({
      all: [group('2026-10-11')],
      peak: [group('2026-10-11', { cost: [cny('2')] })],
      offpeak: [group('2026-10-11', { cost: [cny('1')] })],
      flat: [group('2026-10-11', { cost: [cny('0.5')] })],
    })
    await settle()
    const chart = document.querySelector('[data-tally="daily-chart"][data-currency="CNY"]')!
    expect(chart).not.toBeNull()
    const rects = [...chart.querySelectorAll('rect')]
    const heightOf = (cls: string) => Number(rects.find(r => r.classList.contains(cls) && r.getAttribute('height') !== '0')?.getAttribute('height') ?? 0)
    expect(heightOf('dsh-tally-bar-peak')).toBeGreaterThan(0)
    expect(heightOf('dsh-tally-bar-offpeak') / heightOf('dsh-tally-bar-peak')).toBeCloseTo(0.75)
    expect(document.querySelector('[data-tally="daily-chart"][data-currency="USD"]')).toBeNull()
  })

  it('shows unpriced requests as one muted line in the overview, summing the count', async () => {
    mount({ all: [group('2026-10-10', { unpricedCount: 2 }), group('2026-10-11', { unpricedCount: 3 })] })
    await settle()
    const entry = document.querySelector('[data-tally="overview"] [data-tally="unpriced"]')!
    expect(entry.textContent).toBe(t('tab.unpricedLine', { count: 5 }))
    // The way out (price overrides in the settings) is the line's tooltip.
    expect(entry.closest('[data-tooltip-host]')?.textContent).toContain(zh['settings.overrides'])
  })

  it('puts today and this month side by side, and one progress row per budget', async () => {
    const daily: Budget = { id: 'd', period: 'day', scope: {}, limit: cny('10') }
    mount({}, true, undefined, { budgets: [daily], spend: { d: cny('8.2') } })
    await settle()
    const overview = document.querySelector('[data-tally="overview"]')!
    expect(overview.querySelector('[data-tally="overview-today"]')?.textContent).toContain('¥1.23')
    expect(overview.querySelector('[data-tally="overview-month"]')?.textContent).toContain('¥20.1')
    const row = overview.querySelector('[data-tally="overview-budget"]')!
    expect(row.getAttribute('data-tone')).toBe('warn')
    expect(row.textContent).toContain('82%')
  })

  it('shows no unpriced entry when everything is priced', async () => {
    mount({ all: [group('2026-10-11')] })
    await settle()
    expect(document.querySelector('[data-tally="unpriced"]')).toBeNull()
  })

  it('keeps cache and peak analysis collapsed, then writes the savings fact', async () => {
    const { remote } = mount({ peak: [group('2026-10-11', { cost: [cny('12.5')] })], savings: { peak: [cny('12.5')], offpeakEquivalent: [cny('6.25')], saving: [cny('6.25')] } })
    await settle()
    expect(document.querySelector('[data-tally="savings"]')).toBeNull()
    openAnalysis()
    expect(remote.peakSavings).toHaveBeenCalled()
    expect(document.querySelector('[data-tally="savings"]')?.textContent).toContain(t('tab.savingsFact', { peak: '¥12.5', offpeak: '¥6.25' }))
  })

  it('ranks by cost, names unknown workspaces and marks deleted sessions', async () => {
    mount({
      model: [group('cheap', { cost: [cny('1')] }), group('dear', { cost: [cny('9')] })],
      workspace: [group('', { cost: [cny('2')] })],
      session: [group('s1', { deletedCount: 3 })],
    })
    await settle()
    expect(document.querySelector('[data-tally="ranking-session"] [data-tag]')?.textContent).toBe(t('tab.deleted', { count: 3 }))
    rankTab(zh['tab.byModel'])
    const names = [...document.querySelectorAll('[data-tally="ranking-model"] .dsh-tally-row-name')].map(n => n.textContent)
    expect(names).toEqual(['dear', 'cheap'])
    rankTab(zh['tab.byWorkspace'])
    expect(document.querySelector('[data-tally="ranking-workspace"]')?.textContent).toContain(zh['tab.unknownWorkspace'])
  })

  it('shows the top 10 of a ranking and the rest on "show all"', async () => {
    mount({ model: Array.from({ length: 14 }, (_, i) => group(`m${i}`, { cost: [cny(String(i + 1))] })) })
    await settle()
    rankTab(zh['tab.byModel'])
    expect(document.querySelectorAll('[data-tally="ranking-model"] [data-tally="rank-row"]')).toHaveLength(10)
    fireEvent.click(screen.getByRole('button', { name: zh['tab.showAll'] }))
    expect(document.querySelectorAll('[data-tally="ranking-model"] [data-tally="rank-row"]')).toHaveLength(14)
  })

  it('opened on a session, selects the session ranking and highlights it past the top 10', async () => {
    mount({ session: Array.from({ length: 12 }, (_, i) => group(`s${i}`, { cost: [cny(String(20 - i))] })) }, true, undefined, { params: { sessionId: 's11' } })
    await settle()
    const row = document.querySelector('[data-tally="ranking-session"] [data-tally="rank-row"][data-current="true"]')
    expect(row?.textContent).toContain('s11')
  })

  it('exports through exportCsv and downloads tally-<from>-<to>.csv', async () => {
    const createObjectURL = vi.fn(() => 'blob:csv')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const clicked: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(`${this.download}|${this.href}`) })
    const { remote } = mount({ csv: 'id,cost\n1,0.5\n' })
    await settle()
    exportCsv()
    await settle()
    expect(remote.exportCsv).toHaveBeenCalledTimes(1)
    const request = remote.exportCsv.mock.calls[0]![0] as { from: number; to: number; tz: string }
    expect(request.to - request.from).toBe(7 * DAY)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0]
    expect(blob.size).toBe('id,cost\n1,0.5\n'.length)
    expect(blob.type).toContain('text/csv')
    expect(clicked).toEqual(['tally-2026-10-05-2026-10-11.csv|blob:csv'])
    // Revoked only after the click handler returned, so the download can start.
    expect(revokeObjectURL).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:csv')
  })

  it('reports a failed export without downloading', async () => {
    const createObjectURL = vi.fn(() => 'blob:csv')
    Object.assign(URL, { createObjectURL })
    const { remote } = mount()
    remote.exportCsv.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'no' } } as never)
    await settle()
    exportCsv()
    await settle()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(zh['tab.error'])
  })

  it('shows the empty sentence without any usage, and placeholders without loading text meanwhile', async () => {
    mount()
    expect(document.querySelector('[data-tally="skeleton"]')).not.toBeNull()
    expect(screen.queryByText(zh['tab.loading'])).toBeNull()
    await settle()
    expect(screen.getByText(zh['tab.empty'])).toBeTruthy()
  })

  it('shows an error with retry when a query is refused', async () => {
    mount({}, true, remote => { remote.query.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'no' } } as never) })
    await settle()
    expect(screen.getByRole('alert').textContent).toContain(zh['tab.error'])
    fireEvent.click(screen.getByRole('button', { name: zh['tab.retry'] }))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows each bar\'s amount in its title and the range total per currency', async () => {
    mount({
      all: [group('2026-10-11')],
      peak: [group('2026-10-11', { cost: [cny('2.10'), { amount: '0.5', currency: 'USD' }] })],
      offpeak: [group('2026-10-11', { cost: [cny('1.005')] })],
      flat: [group('2026-10-11', { cost: [cny('0.0001')] })],
    })
    await settle()
    const chart = document.querySelector('[data-tally="daily-chart"][data-currency="CNY"]')!
    const titles = [...chart.querySelectorAll('rect title')].map(n => n.textContent)
    expect(titles).toContain(t('tab.barTitle', { day: '2026-10-11', band: zh['band.peak'], amount: '¥2.1' }))
    expect(titles).toContain(t('tab.barTitle', { day: '2026-10-11', band: zh['band.offpeak'], amount: '¥1.0051' }))
    expect(chart.querySelector('[data-tally="range-total"]')?.textContent).toBe(t('tab.rangeTotal', { total: '¥3.1051' }))
    const usd = document.querySelector('[data-tally="daily-chart"][data-currency="USD"]')!
    expect(usd.querySelector('[data-tally="range-total"]')?.textContent).toBe(t('tab.rangeTotal', { total: '$0.5' }))
  })

  it('reloads on a new hello generation and after recorded usage, keeping the data on screen meanwhile', async () => {
    const view = mount({ peak: [group('2026-10-11', { cost: [cny('1')] })] })
    await settle()
    const total = () => document.querySelector('[data-tally="range-total"]')?.textContent
    expect(total()).toBe(t('tab.rangeTotal', { total: '¥1' }))
    const calls = view.remote.query.mock.calls.length
    view.remote.query.mockImplementation(async (q: UsageQuery) => ok(q.groupBy === 'day' && q.filter?.band === 'peak' ? [group('2026-10-11', { cost: [cny('4')] })] : []))
    act(() => { view.recorded.set(1) })
    expect(screen.queryByText(zh['tab.loading'])).toBeNull()
    await settle()
    expect(view.remote.query.mock.calls.length).toBeGreaterThan(calls)
    expect(total()).toBe(t('tab.rangeTotal', { total: '¥4' }))
    view.remote.query.mockImplementation(async (q: UsageQuery) => ok(q.groupBy === 'day' && q.filter?.band === 'peak' ? [group('2026-10-11', { cost: [cny('7')] })] : []))
    act(() => { view.generation.set(2) })
    await settle()
    expect(total()).toBe(t('tab.rangeTotal', { total: '¥7' }))
  })
})

describe('Rankings focus', () => {
  it('applies the focused session once and keeps the user\'s ranking choice across data refreshes', async () => {
    const { Rankings } = await import('../src/client/dashboard/Rankings.tsx')
    const sessions = (n: number) => Array.from({ length: n }, (_, i) => group(`s${i}`, { cost: [cny(String(20 - i))] }))
    const models = [group('m1', { cost: [cny('1')] })]
    const view = render(<Rankings models={models} workspaces={[]} sessions={sessions(12)} focusSession="s1" t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.byModel'] }))
    expect(document.querySelector('[data-tally="ranking-model"]')).not.toBeNull()
    // A refresh hands a new sessions array with the same focus: the model ranking stays selected.
    view.rerender(<Rankings models={models} workspaces={[]} sessions={sessions(12)} focusSession="s1" t={t} />)
    expect(document.querySelector('[data-tally="ranking-model"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.bySession'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['tab.showAll'] }))
    view.rerender(<Rankings models={models} workspaces={[]} sessions={sessions(12)} focusSession="s1" t={t} />)
    expect(document.querySelectorAll('[data-tally="ranking-session"] [data-tally="rank-row"]')).toHaveLength(12)
  })
})
