/**
 * Stand-ins for the `@deepseek-ai/dsh-client-ui-primitives` atoms the tally elements use. The real
 * bundle imports packages that are only its own dev dependencies (shiki, simple-icons, ...), so
 * it cannot load under vitest; these keep the same props and expose the behavior the tests drive.
 */
import { forwardRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'

export const Button = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<'button'> & { variant?: string; size?: string; icon?: ReactNode }>(
  function Button({ variant: _variant, size: _size, icon, children, ...rest }, ref) {
    return <button ref={ref} type="button" {...rest}>{icon}{children}</button>
  },
)

export const MenuSurface = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'> & { compact?: boolean }>(
  function MenuSurface({ compact: _compact, ...rest }, ref) {
    return <div ref={ref} {...rest} />
  },
)

export function useAnchoredPosition(): Record<string, never> {
  return {}
}

export function useDismissOnOutsidePointer(): void {}

/** Opens on mouse enter, like the real card after its dwell. */
export function HoverCard({ anchor, content }: { anchor: ReactNode; content: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <span data-testid="hover-anchor" onMouseEnter={() => { setOpen(true) }} onMouseLeave={() => { setOpen(false) }}>
      {anchor}
      {open ? <span data-testid="hover-card">{content}</span> : null}
    </span>
  )
}

/** Shows its text; the "fade done" button stands for the real banner finishing its fade. */
export function Toast({ text, onDone }: { text: string; onDone: () => void; holdMs?: number }) {
  return (
    <div role="status">
      {text}
      <button type="button" data-testid="toast-done" onClick={onDone}>done</button>
    </div>
  )
}
