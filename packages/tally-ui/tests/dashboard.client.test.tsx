// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeakSavings, TallyTokens, UsageGroup, UsageQuery } from 'dsh-tally-api'
import { Dashboard } from '../src/client/dashboard/Dashboard.tsx'
import type { DashboardRemote } from '../src/client/dashboard/data.ts'
import { zh } from '../src/client/locales.ts'

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

function mount(script: Script = {}, visible = true, prepare?: (remote: ReturnType<typeof scriptedRemote>['remote']) => void) {
  const fake = scriptedRemote(script)
  prepare?.(fake.remote)
  const useTabInfo = () => ({ tab: { visible } }) as never
  const view = render(<Dashboard remote={fake.remote} now={() => NOW} useTabInfo={useTabInfo} t={t} />)
  return { ...fake, ...view }
}

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
  it('queries a span of exactly 7 days after switching to "7 days"', async () => {
    const { queries } = mount()
    await settle()
    queries.length = 0
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.range.7d'] }))
    await settle()
    expect(queries.length).toBeGreaterThan(0)
    for (const q of queries) expect(q.to - q.from).toBe(7 * DAY)
  })

  it('selects the other ranges too', async () => {
    const { queries } = mount()
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.range.today'] }))
    await settle()
    expect(queries.at(-1)!.to - queries.at(-1)!.from).toBe(DAY)
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

  it('offers the unpriced entry only when requests are unpriced, summing the count', async () => {
    mount({ all: [group('2026-10-10', { unpricedCount: 2 }), group('2026-10-11', { unpricedCount: 3 })] })
    await settle()
    const entry = document.querySelector('[data-tally="unpriced"]')!
    expect(entry.textContent).toContain(t('tab.unpriced', { count: 5 }))
    expect(entry.textContent).toContain(zh['settings.overrides'])
  })

  it('shows no unpriced entry when everything is priced', async () => {
    mount({ all: [group('2026-10-11')] })
    await settle()
    expect(document.querySelector('[data-tally="unpriced"]')).toBeNull()
  })

  it('writes the savings fact from the peakSavings result', async () => {
    const { remote } = mount({ savings: { peak: [cny('12.5')], offpeakEquivalent: [cny('6.25')], saving: [cny('6.25')] } })
    await settle()
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
    const names = [...document.querySelectorAll('[data-tally="ranking-model"] .dsh-tally-row-name')].map(n => n.textContent)
    expect(names).toEqual(['dear', 'cheap'])
    expect(document.querySelector('[data-tally="ranking-workspace"]')?.textContent).toContain(zh['tab.unknownWorkspace'])
    expect(document.querySelector('[data-tally="ranking-session"]')?.textContent).toContain(t('tab.deleted', { count: 3 }))
  })

  it('keeps only the top 10 of a ranking', async () => {
    mount({ model: Array.from({ length: 14 }, (_, i) => group(`m${i}`, { cost: [cny(String(i + 1))] })) })
    await settle()
    expect(document.querySelectorAll('[data-tally="ranking-model"] [data-tally="rank-row"]')).toHaveLength(10)
  })

  it('exports through exportCsv and downloads tally-<from>-<to>.csv', async () => {
    const createObjectURL = vi.fn(() => 'blob:csv')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const clicked: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(`${this.download}|${this.href}`) })
    const { remote } = mount({ csv: 'id,cost\n1,0.5\n' })
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.range.7d'] }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: zh['tab.export'] }))
    await settle()
    expect(remote.exportCsv).toHaveBeenCalledTimes(1)
    const request = remote.exportCsv.mock.calls[0]![0] as { from: number; to: number; tz: string }
    expect(request.to - request.from).toBe(7 * DAY)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0]
    expect(blob.size).toBe('id,cost\n1,0.5\n'.length)
    expect(blob.type).toContain('text/csv')
    expect(clicked).toEqual(['tally-2026-10-05-2026-10-11.csv|blob:csv'])
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:csv')
  })

  it('reports a failed export without downloading', async () => {
    const createObjectURL = vi.fn(() => 'blob:csv')
    Object.assign(URL, { createObjectURL })
    const { remote } = mount()
    remote.exportCsv.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'no' } } as never)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: zh['tab.export'] }))
    await settle()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(zh['tab.error'])
  })

  it('shows an error with retry when a query is refused', async () => {
    mount({}, true, remote => { remote.query.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'no' } } as never) })
    await settle()
    expect(screen.getByRole('alert').textContent).toContain(zh['tab.error'])
    fireEvent.click(screen.getByRole('button', { name: zh['tab.retry'] }))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
