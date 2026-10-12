import { HoverCard, MenuSurface, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import { useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'

/**
 * An ambient value with details: the pointer gets them as a hover card, the keyboard as a panel that
 * opens when the anchor is focused, sits right after it in the tab order and closes on Escape or when
 * focus leaves both.
 */
export function Details({ anchor, content, label }: { anchor: ReactNode; content: ReactNode; label: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  /** Set by a pointer press inside: the focus that follows a click is not keyboard focus. */
  const pressed = useRef(false)
  const position = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, align: 'start', gap: 4, margin: 8 })

  const onFocus = (event: FocusEvent<HTMLSpanElement>) => {
    const byPointer = pressed.current
    pressed.current = false
    if (open || byPointer || panelRef.current?.contains(event.target)) return
    setOpen(true)
  }
  const onBlur = (event: FocusEvent<HTMLSpanElement>) => {
    const next = event.relatedTarget as Node | null
    if (next === null || !rootRef.current?.contains(next)) setOpen(false)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Escape' || !open) return
    event.stopPropagation()
    setOpen(false)
    rootRef.current?.querySelector<HTMLElement>('button')?.focus()
  }

  return (
    <span
      ref={rootRef}
      className="dsh-tally-details"
      onPointerDown={() => { pressed.current = true }}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <HoverCard anchor={anchor} content={content} />
      {open
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
