import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Same distances as dsh's own composer stat pills (`ui-chat` `stat-dialog`). */
const PANEL_GAP = 8
const PANEL_MARGIN = 12
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** A ¥ coin in the 16px, 1px-stroke outline style of the primitives icon set. */
export function CostIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5.75 4.75 8 7.75l2.25-3M8 7.75v3.75M6 8.25h4M6 10h4" />
    </svg>
  )
}

/**
 * A composer stat pill that behaves like dsh's own ("3 轮 58 步", "4.6M tok"): an icon and a label on a
 * round pill that highlights on hover and while open; a click toggles a details dialog above it, and
 * Escape or a press anywhere else closes it. Hovering opens nothing. `children` renders the dialog body
 * and gets `close` for actions that leave it.
 */
export function StatPill({ label, ariaLabel, title, children }: {
  label: ReactNode
  ariaLabel: string
  title: string
  children: (close: () => void) => ReactNode
}): ReactNode {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  return (
    <span ref={rootRef} className="dsh-tally-pill-anchor">
      <button
        type="button"
        className="dsh-tally-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => { setOpen(!open) }}
      >
        <CostIcon />
        <span className="dsh-tally-pill-label">{label}</span>
      </button>
      {open
        ? createPortal(
            <div ref={panelRef} className="dsh-tally-stat-panel" role="dialog" aria-label={title} style={{ position: 'fixed', ...(pos ?? MEASURE_STYLE) }}>
              <div className="dsh-tally-stat-title">
                <span className="dsh-tally-stat-title-label"><CostIcon />{title}</span>
              </div>
              <div className="dsh-tally-stat-rule" aria-hidden="true" />
              {children(() => { setOpen(false) })}
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}
