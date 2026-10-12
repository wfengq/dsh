import { DisclosureRow, SegmentedControl, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Budget, Money, UsageGroup } from 'dsh-tally-api'
import { budgetRatio, budgetTone } from '../budget-progress.ts'
import { formatMoney, formatMoneyList } from '../format.ts'
import { budgetName, costLabel, FORMAT_LOCALE, type T } from '../labels.ts'
import { useSnapshot } from '../settings/form.ts'
import type { Snapshot } from '../store.ts'
import '../card.css'
import { DailyChart } from './DailyChart.tsx'
import { loadDashboard, type DashboardData, type DashboardRemote } from './data.ts'
import { RANGES, rangeBounds, type RangeId } from './definition.ts'
import { ExportMenu } from './ExportButton.tsx'
import { HitRateTrend } from './HitRateTrend.tsx'
import { Rankings } from './Rankings.tsx'
import { Savings } from './Savings.tsx'
import './dashboard.css'

/** What the registration hands the dashboard. */
export interface DashboardInjected {
  remote: DashboardRemote
  /** The store's `hello` count: everything may have changed, so the page reloads. */
  generation: Snapshot<number>
  /** Bumped after the store's debounced refetch following `recorded` frames: new usage was written. */
  recorded: Snapshot<number>
  today: Snapshot<UsageGroup | null>
  month: Snapshot<UsageGroup | null>
  budgets: Snapshot<readonly Budget[] | null>
  budgetSpend: Snapshot<Readonly<Record<string, Money>>>
  /** Clock, epoch milliseconds; defaults to `Date.now`. */
  now?: () => number
}

export type DashboardProps = DashboardInjected & { useTabInfo: UseSidebarRightTabInfo; t: T }

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: DashboardData }

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The session the tab was opened on (`openTab(kind, { params: { sessionId } })`), if any. */
function focusOf(params: unknown): string | undefined {
  const id = (params as { sessionId?: unknown } | undefined)?.sessionId
  return typeof id === 'string' ? id : undefined
}

/** Usage dashboard page of the right sidebar. Loads only while the tab is visible. */
export function Dashboard(props: DashboardProps): ReactNode {
  const { remote, generation, recorded, now = Date.now, useTabInfo, t } = props
  const { tab } = useTabInfo()
  const visible = tab.visible
  const focusSession = focusOf(tab.navigation?.params)
  const [range, setRange] = useState<RangeId>('7d')
  const [state, setState] = useState<State>({ status: 'loading' })
  const [reload, setReload] = useState(0)
  const hello = useSnapshot(generation)
  const written = useSnapshot(recorded)
  const nowRef = useRef(now)
  nowRef.current = now
  /** Range of the data on screen; a refresh of the same range keeps it visible while loading. */
  const shownRange = useRef<RangeId | undefined>(undefined)

  useEffect(() => {
    if (!visible) return
    let current = true
    if (shownRange.current !== range) setState({ status: 'loading' })
    loadDashboard(remote, rangeBounds(range, nowRef.current()), timeZone()).then(
      (data) => {
        if (!current) return
        shownRange.current = range
        setState({ status: 'ready', data })
      },
      () => {
        if (!current) return
        shownRange.current = undefined
        setState({ status: 'error' })
      },
    )
    return () => { current = false }
  }, [remote, range, visible, reload, hello, written])

  const bounds = rangeBounds(range, now())
  const options = RANGES.map(value => ({ value, label: t(`tab.range.${value}`) }))
  return (
    <div className="dsh-tally-dashboard" data-tally="dashboard">
      <div className="dsh-tally-toolbar">
        <h2 className="dsh-tally-page-title">{t('tab.title')}</h2>
        <SegmentedControl id="dsh-tally-range" value={range} options={options} onChange={setRange} label={t('tab.range.label')} />
        <ExportMenu remote={remote} range={bounds} tz={timeZone()} t={t} />
      </div>
      <Overview {...props} data={state.status === 'ready' ? state.data : null} />
      {state.status === 'loading'
        ? (
            <div className="dsh-tally-skeletons" data-tally="skeleton" aria-busy="true">
              <div className="dsh-tally-skeleton" />
              <div className="dsh-tally-skeleton" />
            </div>
          )
        : null}
      {state.status === 'error'
        ? (
            <div className="dsh-tally-card dsh-tally-pad" role="alert">
              {t('tab.error')}
              {' '}
              <button type="button" className="dsh-tally-link" onClick={() => { setState({ status: 'loading' }); setReload(n => n + 1) }}>{t('tab.retry')}</button>
            </div>
          )
        : null}
      {state.status === 'ready' ? <Content data={state.data} focusSession={focusSession} t={t} /> : null}
    </div>
  )
}

function Overview({ today, month, budgets, budgetSpend, data, t }: DashboardProps & { data: DashboardData | null }): ReactNode {
  const todayGroup = useSnapshot(today)
  const monthGroup = useSnapshot(month)
  const list = useSnapshot(budgets) ?? []
  const spend = useSnapshot(budgetSpend)
  const rangeTotal = data === null ? null : formatMoneyList(data.charts.map(c => ({ amount: c.total, currency: c.currency })), FORMAT_LOCALE)
  return (
    <section className="dsh-tally-card dsh-tally-overview" data-tally="overview">
      <div className="dsh-tally-overview-figures">
        <div className="dsh-tally-figure" data-tally="overview-today">
          <span className="dsh-tally-figure-label">{t('dock.today')}</span>
          <span className="dsh-tally-figure-value dsh-tally-num">{todayGroup === null ? '—' : costLabel(todayGroup, t)}</span>
        </div>
        <div className="dsh-tally-figure" data-tally="overview-month">
          <span className="dsh-tally-figure-label">{t('dock.month')}</span>
          <span className="dsh-tally-figure-value dsh-tally-num">{monthGroup === null ? '—' : costLabel(monthGroup, t)}</span>
        </div>
      </div>
      {data === null ? null : <p className="dsh-tally-row-muted">{t('tab.rangeSummary', { total: rangeTotal ?? '—', count: data.requestCount })}</p>}
      {list.map((budget) => {
        const spent = spend[budget.id] ?? { amount: '0', currency: budget.limit.currency }
        const ratio = budgetRatio(spent, budget.limit)
        return (
          <div key={budget.id} className="dsh-tally-overview-budget" data-tally="overview-budget" data-tone={budgetTone(ratio)}>
            <span className="dsh-tally-row-label">{budgetName(budget, budget.limit, t)}</span>
            <span className="dsh-tally-num">{`${Math.floor(ratio * 100)}% · ${formatMoney(spent, FORMAT_LOCALE)}`}</span>
            <span className="dsh-tally-progress-track dsh-tally-wide" aria-hidden="true">
              <span className="dsh-tally-progress-fill" style={{ '--dsh-tally-progress': String(Math.min(ratio, 1)) } as CSSProperties} />
            </span>
          </div>
        )
      })}
      {data !== null && data.unpricedCount > 0
        ? (
            <Tooltip label={t('tab.unpricedHint', { nav: t('settings.nav'), overrides: t('settings.overrides') })}>
              <span className="dsh-tally-row-muted dsh-tally-unpriced" data-tally="unpriced" tabIndex={0}>
                {t('tab.unpricedLine', { count: data.unpricedCount })}
              </span>
            </Tooltip>
          )
        : null}
    </section>
  )
}

function Content({ data, focusSession, t }: { data: DashboardData; focusSession: string | undefined; t: T }): ReactNode {
  const [analysis, setAnalysis] = useState(false)
  const empty = data.charts.length === 0 && data.models.length === 0 && data.sessions.length === 0 && data.unpricedCount === 0
  if (empty) return <p className="dsh-tally-card dsh-tally-pad dsh-tally-row-muted">{t('tab.empty')}</p>
  return (
    <>
      {data.charts.map(chart => (
        <section key={chart.currency} className="dsh-tally-card dsh-tally-pad">
          <DailyChart chart={chart} t={t} />
        </section>
      ))}
      <Rankings models={data.models} workspaces={data.workspaces} sessions={data.sessions} focusSession={focusSession} t={t} />
      <div className="dsh-tally-card dsh-tally-pad">
        <DisclosureRow
          icon={null}
          title={t('tab.analysis')}
          open={analysis}
          expandable
          expandOnRowClick
          onToggle={() => { setAnalysis(o => !o) }}
          className="dsh-tally-disclosure"
        >
          <div className="dsh-tally-analysis">
            <HitRateTrend rates={data.hitRates} t={t} />
            <Savings savings={data.savings} t={t} />
          </div>
        </DisclosureRow>
      </div>
    </>
  )
}
