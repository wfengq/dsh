import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { T } from '../labels.ts'
import { useSnapshot } from '../settings/form.ts'
import type { Snapshot } from '../store.ts'
import { DailyChart } from './DailyChart.tsx'
import { loadDashboard, type DashboardData, type DashboardRemote } from './data.ts'
import { RANGES, rangeBounds, type RangeId } from './definition.ts'
import { ExportButton } from './ExportButton.tsx'
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
  /** Clock, epoch milliseconds; defaults to `Date.now`. */
  now?: () => number
}

export type DashboardProps = DashboardInjected & { useTabInfo: UseSidebarRightTabInfo; t: T }

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: DashboardData }

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** Usage dashboard page of the right sidebar. Loads only while the tab is visible. */
export function Dashboard({ remote, generation, recorded, now = Date.now, useTabInfo, t }: DashboardProps): ReactNode {
  const { tab } = useTabInfo()
  const visible = tab.visible
  const [range, setRange] = useState<RangeId>('today')
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
        <SegmentedControl id="dsh-tally-range" value={range} options={options} onChange={setRange} label={t('tab.range.label')} />
        <ExportButton remote={remote} range={bounds} tz={timeZone()} t={t} />
      </div>
      {state.status === 'loading' ? <p className="dsh-tally-hint" role="status">{t('tab.loading')}</p> : null}
      {state.status === 'error'
        ? (
            <p className="dsh-tally-error" role="alert">
              {t('tab.error')}
              {' '}
              <button type="button" className="dsh-tally-link" onClick={() => { setState({ status: 'loading' }); setReload(n => n + 1) }}>{t('tab.retry')}</button>
            </p>
          )
        : null}
      {state.status === 'ready' ? <Content data={state.data} t={t} /> : null}
    </div>
  )
}

function Content({ data, t }: { data: DashboardData; t: T }): ReactNode {
  const empty = data.charts.length === 0 && data.models.length === 0 && data.unpricedCount === 0
  return (
    <>
      {data.unpricedCount > 0
        ? (
            <div className="dsh-tally-unpriced" data-tally="unpriced">
              <strong>{t('tab.unpriced', { count: data.unpricedCount })}</strong>
              <span>{t('tab.unpricedHint', { nav: t('settings.nav'), overrides: t('settings.overrides') })}</span>
            </div>
          )
        : null}
      {empty ? <p className="dsh-tally-hint">{t('tab.empty')}</p> : null}
      {data.charts.map(chart => <DailyChart key={chart.currency} chart={chart} t={t} />)}
      <Savings savings={data.savings} t={t} />
      {empty ? null : <HitRateTrend rates={data.hitRates} t={t} />}
      <Rankings models={data.models} workspaces={data.workspaces} sessions={data.sessions} t={t} />
    </>
  )
}
