import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { BalanceSnapshot, BandView, Budget, Money, SessionView, TallyStatusView, UsageGroup } from 'dsh-tally-api'
import { BalanceText } from './BalanceText.tsx'
import { budgetRatio, budgetTone, pickDockBudget } from './budget-progress.ts'
import { addDecimal } from './dashboard/decimal.ts'
import type { Elements } from './elements.ts'
import { formatCountdown, formatMoney } from './format.ts'
import { budgetName, costLabel, FORMAT_LOCALE, type T } from './labels.ts'
import { StatPill } from './StatPill.tsx'
import type { Snapshot, TallyStore } from './store.ts'
import './CostDock.css'

/** What the registration hands the dock for one session. */
export interface CostDockInjected {
  hooks: {
    elements: Snapshot<Elements>
    session: Snapshot<SessionView | null>
    today: Snapshot<UsageGroup | null>
    month: Snapshot<UsageGroup | null>
    budgets: Snapshot<readonly Budget[] | null>
    budgetSpend: Snapshot<Readonly<Record<string, Money>>>
    balances: Snapshot<Readonly<Record<string, BalanceSnapshot>>>
    status: Snapshot<TallyStatusView | null>
  }
  refreshBalance: TallyStore['refreshBalance']
  /** The `tally/band` call; `null` when no price is known or the call failed. */
  band: (request: { route: string; model: string; at: number }) => Promise<BandView | null>
  openDashboard: (sessionId?: string) => void
  /** Whether the usage tab can open now (a right sidebar exists and the tab is switched on). */
  canOpenDashboard: () => boolean
}

export type CostDockProps = InjectFace<CostDockInjected> & { t: T }

const TICK_MS = 1000

/**
 * The band of the session's latest route and model, counting down to its next change once a second.
 * `null` until known, or when no price is known.
 */
function useBand(route: string | null, model: string | null, band: CostDockInjected['band']): { view: BandView | null; now: number } {
  const [answer, setAnswer] = useState<{ view: BandView | null; at: number }>({ view: null, at: 0 })
  const [now, setNow] = useState(() => Date.now())
  const [generation, setGeneration] = useState(0)
  const expired = useRef<BandView | null>(null)
  const view = answer.view

  useEffect(() => {
    if (route === null || model === null) { setAnswer({ view: null, at: 0 }); return }
    let live = true
    const at = Date.now()
    band({ route, model, at }).then(
      (next) => { if (live) { setAnswer({ view: next, at }); setNow(Date.now()) } },
      () => { if (live) setAnswer({ view: null, at }) },
    )
    return () => { live = false }
  }, [route, model, band, generation])

  useEffect(() => {
    if (view?.until == null) return
    const timer = setInterval(() => { setNow(Date.now()) }, TICK_MS)
    return () => { clearInterval(timer) }
  }, [view])

  // At zero the band has changed: ask again, once per answer, unless the answer was already past
  // when it was asked for (which would only repeat itself).
  useEffect(() => {
    if (view?.until == null || now < view.until || expired.current === view || view.until <= answer.at) return
    expired.current = view
    setGeneration(g => g + 1)
  }, [view, now, answer.at])

  return { view, now }
}

function bandText(view: BandView, now: number, t: T): string {
  const name = t(`band.${view.band}`)
  return view.until === null ? name : t('band.countdown', { band: name, time: formatCountdown(view.until - now, FORMAT_LOCALE) })
}

function Line({ label, value, tally }: { label: string; value: ReactNode; tally?: string }): ReactNode {
  return (
    <div className="dsh-tally-dock-line" data-tally={tally}>
      <span className="dsh-tally-dock-line-label">{label}</span>
      <span className="dsh-tally-num">{value}</span>
    </div>
  )
}

/**
 * Ambient cost pill below the composer: today's and this month's cost, the budget closest to its limit
 * and the current price band. It behaves like dsh's own stat pills next to it: a click toggles the
 * details (session, every budget, balance, a way to the usage dashboard) above it.
 */
export function CostDock(props: CostDockProps): ReactNode {
  const { useElements, useSession, useToday, useMonth, useBudgets, useBudgetSpend, useBalances, useStatus, refreshBalance, band, openDashboard, canOpenDashboard, t } = props
  const enabled = useElements((e: Elements) => e.composerDock)
  // Read through the hook so switching the usage tab re-renders the dock.
  const canOpen = useElements((e: Elements) => e.sidebarTab) && canOpenDashboard()
  const session = useSession((s: SessionView | null) => s)
  const today = useToday((s: UsageGroup | null) => s)
  const month = useMonth((s: UsageGroup | null) => s)
  const budgets: readonly Budget[] = useBudgets((b: readonly Budget[] | null) => b) ?? []
  const spend: Readonly<Record<string, Money>> = useBudgetSpend((s: Readonly<Record<string, Money>>) => s)
  const firstRoute = useStatus((s: TallyStatusView | null) => s?.balanceRoutes[0] ?? null)
  const route = session?.lastRoute ?? firstRoute
  const balance = useBalances((b: Readonly<Record<string, BalanceSnapshot>>) => (route === null ? undefined : b[route]))
  const hasEntries = session !== null && session.usage.total.requestCount > 0
  const { view: bandView, now } = useBand(hasEntries ? session.lastRoute : null, hasEntries ? session.lastModel : null, band)
  if (!enabled) return null

  const picked = pickDockBudget(budgets, spend)
  const tone = picked === null ? null : budgetTone(picked.ratio)
  const budgetLabel = picked === null
    ? null
    : tone === 'over'
      ? t('dock.budgetOver', { amount: formatMoney({ amount: addDecimal(picked.spent.amount, `-${picked.budget.limit.amount}`), currency: picked.budget.limit.currency }, FORMAT_LOCALE) })
      : t('dock.budget', { pct: Math.floor(picked.ratio * 100) })

  const todayText = today === null ? '—' : costLabel(today, t)
  const monthText = month === null ? '—' : costLabel(month, t)
  const ariaLabel = [`${t('dock.today')} ${todayText}`, `${t('dock.month')} ${monthText}`, budgetLabel, bandView === null ? null : bandText(bandView, now, t)]
    .filter((part): part is string => part !== null).join(' · ')

  const bar = (
    <span className="dsh-tally-dock-bar">
      <span className="dsh-tally-dock-item" data-tally-item="today">
        <span className="dsh-tally-label">{t('dock.today')}</span>
        <span className="dsh-tally-num">{todayText}</span>
      </span>
      <span className="dsh-tally-dock-item" data-tally-item="month">
        <span className="dsh-tally-label">{t('dock.month')}</span>
        <span className="dsh-tally-num">{monthText}</span>
      </span>
      {picked === null
        ? null
        : (
            <span className="dsh-tally-dock-item" data-tally-item="budget" data-tone={tone}>
              <span className="dsh-tally-num">{budgetLabel}</span>
              <span className="dsh-tally-progress-track" aria-hidden="true">
                <span className="dsh-tally-progress-fill" style={{ '--dsh-tally-progress': String(Math.min(picked.ratio, 1)) } as CSSProperties} />
              </span>
            </span>
          )}
      {bandView === null
        ? null
        : (
            <span className="dsh-tally-dock-item" data-tally-item="band" data-band={bandView.band}>
              <StateDot state={bandView.band === 'peak' ? 'warning' : 'done'} size={8} />
              <span className="dsh-tally-num">{bandText(bandView, now, t)}</span>
            </span>
          )}
    </span>
  )

  const details = (close: () => void) => (
    <div className="dsh-tally-dock-card">
      {hasEntries ? <Line tally="session" label={t('dock.session')} value={costLabel(session.usage.total, t)} /> : null}
      <Line tally="today" label={t('dock.today')} value={today === null ? '—' : costLabel(today, t)} />
      <Line tally="month" label={t('dock.month')} value={month === null ? '—' : costLabel(month, t)} />
      {budgets.map((budget) => {
        const spent = spend[budget.id] ?? { amount: '0', currency: budget.limit.currency }
        return (
          <div key={budget.id} className="dsh-tally-dock-line" data-tally="budget-line" data-tone={budgetTone(budgetRatio(spent, budget.limit))}>
            <span className="dsh-tally-dock-line-label">{budgetName(budget, budget.limit, t)}</span>
            <span className="dsh-tally-num">{t('settings.budget.spent', { spent: formatMoney(spent, FORMAT_LOCALE), limit: formatMoney(budget.limit, FORMAT_LOCALE) })}</span>
          </div>
        )
      })}
      {route !== null
        ? (
            <div className="dsh-tally-dock-line">
              <BalanceText snapshot={balance} onRefresh={() => refreshBalance(route)} t={t} />
            </div>
          )
        : null}
      {bandView === null ? null : <Line label={t('dock.band')} value={bandText(bandView, now, t)} />}
      {canOpen ? <button type="button" className="dsh-tally-link" onClick={() => { close(); openDashboard() }}>{t('dock.openDashboard')}</button> : null}
    </div>
  )

  return (
    <div className="dsh-tally-dock" data-tally="dock">
      <StatPill label={bar} ariaLabel={ariaLabel} title={t('dock.details')}>{details}</StatPill>
    </div>
  )
}
