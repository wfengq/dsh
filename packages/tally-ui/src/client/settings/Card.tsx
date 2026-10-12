/** Settings card and row in dsh's own settings layout: name and hint on the left, the control on the right. */
import type { ReactNode } from 'react'
import '../card.css'

export function SettingsCard({ title, description, children, tally }: {
  title: string
  description?: ReactNode
  children: ReactNode
  /** `data-tally` hook of the card. */
  tally?: string
}): ReactNode {
  return (
    <section className="dsh-tally-card-group" data-tally={tally}>
      <h3 className="dsh-tally-card-title">{title}</h3>
      {description === undefined ? null : <p className="dsh-tally-card-description">{description}</p>}
      <div className="dsh-tally-card">{children}</div>
    </section>
  )
}

export function SettingsRow({ label, hint, control, tally, tone }: {
  label: ReactNode
  hint?: ReactNode
  control?: ReactNode
  tally?: string
  tone?: string
}): ReactNode {
  return (
    <div className="dsh-tally-row" data-tally={tally} data-tone={tone}>
      <div className="dsh-tally-row-text">
        <div className="dsh-tally-row-label">{label}</div>
        {hint === undefined ? null : <div className="dsh-tally-row-hint">{hint}</div>}
      </div>
      {control === undefined ? null : <div className="dsh-tally-row-control">{control}</div>}
    </div>
  )
}
