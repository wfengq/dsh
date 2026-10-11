import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { BalanceSnapshot, BandView, SessionView, TallyStatusView, UsageGroup } from 'dsh-tally-api'
import { BalanceText } from './BalanceText.tsx'
import type { Elements } from './elements.ts'
import { formatCountdown } from './format.ts'
import { costLabel, FORMAT_LOCALE, type T } from './labels.ts'
import type { Snapshot, TallyStore } from './store.ts'
import './CostDock.css'

/** What the registration hands the dock for one session. */
export interface CostDockInjected {
  hooks: {
    elements: Snapshot<Elements>
    session: Snapshot<SessionView | null>
    today: Snapshot<UsageGroup | null>
    balances: Snapshot<Readonly<Record<string, BalanceSnapshot>>>
    status: Snapshot<TallyStatusView | null>
  }
  refreshBalance: TallyStore['refreshBalance']
  /** The `tally/band` call; `null` when no price is known or the call failed. */
  band: (request: { route: string; model: string; at: number }) => Promise<BandView | null>
}

export type CostDockProps = InjectFace<CostDockInjected> & { t: T }

/**
 * Ambient cost line below the composer: this session's cost, today's cost, the balance and the
 * current price band with its countdown. Before the session has any entries only today's cost and
 * the balance show.
 */
export function CostDock({ useElements, useSession, useToday, useBalances, useStatus, refreshBalance, band, t }: CostDockProps): ReactNode {
  const enabled = useElements((e: Elements) => e.composerDock)
  const session = useSession((s: SessionView | null) => s)
  const today = useToday((s: UsageGroup | null) => s)
  const firstRoute = useStatus((s: TallyStatusView | null) => s?.balanceRoutes[0] ?? null)
  const route = session?.lastRoute ?? firstRoute
  const balance = useBalances((b: Readonly<Record<string, BalanceSnapshot>>) => (route === null ? undefined : b[route]))
  if (!enabled) return null

  const hasEntries = session !== null && session.usage.total.requestCount > 0
  return (
    <div className="dsh-tally-dock" data-tally="dock">
      {hasEntries
        ? (
            <span className="dsh-tally-item" data-tally="session">
              <span className="dsh-tally-label">{t('dock.session')}</span>
              <span className="dsh-tally-num">{costLabel(session.usage.total, t)}</span>
            </span>
          )
        : null}
      <span className="dsh-tally-item" data-tally="today">
        <span className="dsh-tally-label">{t('dock.today')}</span>
        <span className="dsh-tally-num">{today === null ? '—' : costLabel(today, t)}</span>
      </span>
      {route !== null
        ? <span className="dsh-tally-item"><BalanceText snapshot={balance} onRefresh={() => refreshBalance(route)} t={t} /></span>
        : null}
      {hasEntries && session.lastRoute !== null && session.lastModel !== null
        ? <BandCountdown route={session.lastRoute} model={session.lastModel} band={band} t={t} />
        : null}
    </div>
  )
}

const TICK_MS = 1000

/** The band of the session's latest route and model, counting down to its next change once a second. */
function BandCountdown({ route, model, band, t }: { route: string; model: string; band: CostDockInjected['band']; t: T }): ReactNode {
  const [answer, setAnswer] = useState<{ view: BandView | null; at: number }>({ view: null, at: 0 })
  const [now, setNow] = useState(() => Date.now())
  const [generation, setGeneration] = useState(0)
  const expired = useRef<BandView | null>(null)
  const view = answer.view

  useEffect(() => {
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

  if (view === null) return null
  const name = t(`band.${view.band}`)
  return (
    <span className="dsh-tally-item" data-tally="band" data-band={view.band}>
      <span className="dsh-tally-num">
        {view.until === null ? name : t('band.countdown', { band: name, time: formatCountdown(view.until - now, FORMAT_LOCALE) })}
      </span>
    </span>
  )
}
