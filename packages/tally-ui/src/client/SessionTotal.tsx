import { useEffect, useState, type ReactNode } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionView, UsageGroup } from 'dsh-tally-api'
import type { Elements } from './elements.ts'
import { costLabel, type T } from './labels.ts'
import { StatPill } from './StatPill.tsx'
import type { Snapshot } from './store.ts'
import './SessionTotal.css'

/** What the registration hands the header total for one session. */
export interface SessionTotalInjected {
  hooks: {
    elements: Snapshot<Elements>
    session: Snapshot<SessionView | null>
  }
  sessionId: string
  /** The session (subagents included) grouped by model; `null` when the call failed. */
  loadModels: (sessionId: string) => Promise<UsageGroup[] | null>
  openDashboard: (sessionId?: string) => void
  canOpenDashboard: () => boolean
}

export type SessionTotalProps = InjectFace<SessionTotalInjected> & { t: T }

/** Per-model split of the session, read when the card opens. */
function ModelSplit({ sessionId, loadModels, t }: { sessionId: string; loadModels: SessionTotalInjected['loadModels']; t: T }): ReactNode {
  const [models, setModels] = useState<UsageGroup[] | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    loadModels(sessionId).then(next => { if (live) setModels(next) }, () => { if (live) setModels(null) })
    return () => { live = false }
  }, [sessionId, loadModels])
  if (models === undefined) return <div className="dsh-tally-total-caption">{t('tab.loading')}</div>
  if (models === null) return <div className="dsh-tally-total-caption">{t('tab.error')}</div>
  return (
    <>
      {models.map(model => (
        <div key={model.key} className="dsh-tally-total-row" data-tally="model-row">
          <span className="dsh-tally-total-id">{model.key}</span>
          <span className="dsh-tally-total-meta">{t('header.requests', { count: model.requestCount })}</span>
          <span className="dsh-tally-num">{costLabel(model, t)}</span>
        </div>
      ))}
    </>
  )
}

/**
 * Session header total, subagents included. Like the stat buttons below the composer, a click toggles its
 * details below it: the split by model, the subagent sessions and a way to the usage dashboard on this
 * session. Shows `—` until the session has entries, never a zero.
 */
export function SessionTotal({ useElements, useSession, sessionId, loadModels, openDashboard, canOpenDashboard, t }: SessionTotalProps): ReactNode {
  const enabled = useElements((e: Elements) => e.headerUtilities)
  const canOpen = useElements((e: Elements) => e.sidebarTab) && canOpenDashboard()
  const session = useSession((s: SessionView | null) => s)
  if (!enabled) return null
  const hasEntries = session !== null && session.usage.total.requestCount > 0
  const total = hasEntries ? costLabel(session.usage.total, t) : '—'
  const children = session?.usage.children ?? []
  const card = (close: () => void) => (
    <div className="dsh-tally-total-card">
      {hasEntries ? <ModelSplit sessionId={sessionId} loadModels={loadModels} t={t} /> : null}
      {children.length > 0
        ? (
            <>
              <div className="dsh-tally-total-caption">{t('header.subagents', { count: children.length })}</div>
              {children.map((child: SessionView['usage']['children'][number]) => (
                <div key={child.sessionId} className="dsh-tally-total-row" data-tally="subagent">
                  <span className="dsh-tally-total-id" title={child.sessionId}>{child.sessionId}</span>
                  <span className="dsh-tally-num">{costLabel(child.total, t)}</span>
                </div>
              ))}
            </>
          )
        : null}
      {canOpen ? <button type="button" className="dsh-tally-link" onClick={() => { close(); openDashboard(sessionId) }}>{t('dock.openDashboard')}</button> : null}
    </div>
  )
  return (
    <span className="dsh-tally-total">
      <StatPill
        variant="header"
        side="bottom"
        align="end"
        tally="total"
        label={(
          <>
            <span className="dsh-tally-label">{t('dock.session')}</span>
            {' '}
            <span className="dsh-tally-num">{total}</span>
          </>
        )}
        ariaLabel={`${t('header.total')} ${total}`}
        title={t('header.total')}
        titleValue={total}
      >
        {card}
      </StatPill>
    </span>
  )
}
