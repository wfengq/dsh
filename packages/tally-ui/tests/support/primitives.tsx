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
export function Toast({ text, onDone, actions }: { text: string; onDone: () => void; holdMs?: number; actions?: readonly { label: string; onClick: () => void }[] }) {
  return (
    <div role="status">
      <span data-testid="toast-text">{text}</span>
      {(actions ?? []).map(action => <button key={action.label} type="button" onClick={action.onClick}>{action.label}</button>)}
      <button type="button" data-testid="toast-done" onClick={onDone}>done</button>
    </div>
  )
}

/** Renders one button per option; selecting reports the chosen value like the real tablist. */
export function SegmentedControl<Value extends string>(
  { id, value, options, onChange, label }: {
    id: string
    value: Value
    options: readonly { value: Value; label: string; disabled?: boolean }[]
    onChange: (next: Value) => void
    label: string
    disabled?: boolean
    className?: string
  },
) {
  return (
    <div role="tablist" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          id={`${id}-${option.value}`}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => { if (option.value !== value) onChange(option.value) }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** A labelled checkbox standing in for the real switch. */
export function Switch({ checked, onChange, label, disabled, title }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string | undefined
  className?: string | undefined
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={title} disabled={disabled} onClick={() => { onChange(!checked) }} />
  )
}

export const Input = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<'input'> & { icon?: ReactNode }>(
  function Input({ icon: _icon, ...rest }, ref) {
    return <input ref={ref} {...rest} />
  },
)

/** Renders its content while open, as a labelled dialog. */
export function Modal({ open, onClose: _onClose, title, children, footer }: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  closeLabel?: string
  headless?: boolean
}) {
  return open ? <div role="dialog" aria-modal="true" aria-label={title}>{children}{footer}</div> : null
}

interface MenuEntryStub { id?: string; label?: ReactNode; danger?: boolean; disabled?: boolean; type?: string }

/** The anchor, plus one menuitem button per item while open; choosing one reports its id and closes. */
export function Menu({ open, anchor, items, onSelect, onClose }: {
  open: boolean
  anchor: ReactNode
  items?: readonly MenuEntryStub[]
  onSelect?: (id: string) => void
  onClose: () => void
  [key: string]: unknown
}) {
  return (
    <>
      {anchor}
      {open
        ? (
            <div role="menu">
              {(items ?? []).filter(item => item.id !== undefined).map(item => (
                <button key={item.id} type="button" role="menuitem" disabled={item.disabled} onClick={() => { onSelect?.(item.id!); onClose() }}>{item.label}</button>
              ))}
            </div>
          )
        : null}
    </>
  )
}

/** A toggle button carrying the title; the content shows while open. */
export function DisclosureRow({ title, open, onToggle, children, collapsedContent }: {
  title: string
  open: boolean
  onToggle: () => void
  children?: ReactNode
  collapsedContent?: ReactNode
  [key: string]: unknown
}) {
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={onToggle}>{title}</button>
      {open ? children : collapsedContent}
    </div>
  )
}

export function StateDot({ state }: { state: string; [key: string]: unknown }) {
  return <span data-state-dot={state} aria-hidden="true" />
}

/** Renders the child with its label as a description, so tests can find tooltip text. */
export function Tooltip({ label, children }: { label: ReactNode; children: ReactNode; [key: string]: unknown }) {
  return <span data-tooltip-host="">{children}<span hidden data-tooltip="">{label}</span></span>
}

export function Tag({ children, tone }: { children?: ReactNode; tone?: string; className?: string }) {
  return <span data-tag={tone ?? ''}>{children}</span>
}
