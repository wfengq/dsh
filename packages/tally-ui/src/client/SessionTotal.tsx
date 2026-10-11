import { MenuSurface, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionView } from 'dsh-tally-api'
import type { Elements } from './elements.ts'
import { costLabel, type T } from './labels.ts'
import type { Snapshot } from './store.ts'
import './SessionTotal.css'

/** What the registration hands the header total for one session. */
export interface SessionTotalInjected {
  hooks: {
    elements: Snapshot<Elements>
    session: Snapshot<SessionView | null>
  }
}

export type SessionTotalProps = InjectFace<SessionTotalInjected> & { t: T }

/**
 * Session header total, subagents included. Clicking it opens a menu with one row per subagent
 * session. Shows `—` until the session has entries, never a zero.
 */
export function SessionTotal({ useElements, useSession, t }: SessionTotalProps): ReactNode {
  const enabled = useElements((e: Elements) => e.headerUtilities)
  const session = useSession((s: SessionView | null) => s)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open, anchorRef, panelRef, align: 'end', gap: 4, margin: 8 })
  useDismissOnOutsidePointer(rootRef, open, setOpen)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open])

  if (!enabled) return null
  const total = session !== null && session.usage.total.requestCount > 0 ? costLabel(session.usage.total, t) : '—'
  const children = session?.usage.children ?? []
  return (
    <span className="dsh-tally-total" ref={rootRef}>
      <button
        ref={anchorRef}
        type="button"
        className="dsh-tally-total-button"
        data-tally="total"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('header.total')}
        onClick={() => { setOpen(o => !o) }}
      >
        <span className="dsh-tally-num">{total}</span>
      </button>
      {open
        ? (
            <MenuSurface
              ref={panelRef}
              role="menu"
              compact
              className="dsh-tally-total-menu"
              style={{ position: 'fixed', ...position, ...(position === null ? { visibility: 'hidden' } : {}) }}
            >
              <div className="dsh-tally-total-head">
                <span>{t('header.total')}</span>
                <span className="dsh-tally-num">{total}</span>
              </div>
              <div className="dsh-tally-total-caption">{t('header.subagents', { count: children.length })}</div>
              {children.map((child: SessionView['usage']['children'][number]) => (
                <div key={child.sessionId} role="menuitem" className="dsh-tally-total-row" data-tally="subagent">
                  <span className="dsh-tally-total-id" title={child.sessionId}>{child.sessionId}</span>
                  <span className="dsh-tally-num">{costLabel(child.total, t)}</span>
                </div>
              ))}
            </MenuSurface>
          )
        : null}
    </span>
  )
}
