import { MenuSurface, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'

/** How long the pointer rests on the anchor before the details open. */
const OPEN_DELAY_MS = 400
/** How long the details stay after the pointer leaves, so it can cross the gap onto them. */
const CLOSE_DELAY_MS = 150

/**
 * An ambient value with details in one panel kept inside the window: the pointer opens it after a
 * short rest and it closes once the pointer leaves both; the keyboard opens it when the anchor is
 * focused, it sits right after the anchor in the tab order and closes on Escape or when focus leaves
 * both. `side` and `align` say where the panel hangs from the anchor before the viewport clamp.
 */
export function Details({ anchor, content, label, side = 'bottom', align = 'start' }: {
  anchor: ReactNode
  content: ReactNode
  label: string
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
}): ReactNode {
  const [open, setOpen] = useState<'pointer' | 'keyboard' | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  /** Set by a pointer press inside: the focus that follows a click is not keyboard focus. */
  const pressed = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const position = useAnchoredPosition({ open: open !== null, anchorRef: rootRef, panelRef, side, align, gap: 4, margin: 8 })

  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clearTimer, [])

  const onMouseEnter = () => {
    clearTimer()
    if (open === null) timer.current = setTimeout(() => { setOpen('pointer') }, OPEN_DELAY_MS)
  }
  const onMouseLeave = () => {
    clearTimer()
    if (open === 'pointer') timer.current = setTimeout(() => { setOpen(null) }, CLOSE_DELAY_MS)
  }
  const onFocus = (event: FocusEvent<HTMLSpanElement>) => {
    const byPointer = pressed.current
    pressed.current = false
    if (open !== null || byPointer || panelRef.current?.contains(event.target)) return
    clearTimer()
    setOpen('keyboard')
  }
  const onBlur = (event: FocusEvent<HTMLSpanElement>) => {
    const next = event.relatedTarget as Node | null
    if (open === 'keyboard' && (next === null || !rootRef.current?.contains(next))) setOpen(null)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Escape' || open === null) return
    event.stopPropagation()
    setOpen(null)
    rootRef.current?.querySelector<HTMLElement>('button')?.focus()
  }

  return (
    <span
      ref={rootRef}
      className="dsh-tally-details"
      onPointerDown={() => { pressed.current = true }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      {anchor}
      {open !== null
        ? (
            <MenuSurface
              ref={panelRef}
              role="dialog"
              aria-label={label}
              compact
              className="dsh-tally-details-panel"
              style={{ position: 'fixed', ...position, ...(position === null ? { visibility: 'hidden' } : {}) }}
            >
              {content}
            </MenuSurface>
          )
        : null}
    </span>
  )
}
