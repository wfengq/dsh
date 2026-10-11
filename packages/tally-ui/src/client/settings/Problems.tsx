import type { ReactNode } from 'react'
import type { TallyStatusView } from 'dsh-tally-api'
import type { T } from '../labels.ts'
import type { Snapshot } from '../store.ts'
import { useSnapshot } from './form.ts'

/**
 * Problems the Host reports in its status (spec §6): unreadable session logs, ledger errors, unusable
 * price overrides and budget file errors. A ledger error comes with the hint that the ledger can be
 * rebuilt from the logs. Renders nothing while there is no problem.
 */
export function Problems({ status, t }: { status: Snapshot<TallyStatusView | null>; t: T }): ReactNode {
  const view = useSnapshot(status)
  if (view === null) return null
  const items: { key: string; text: string }[] = []
  let ledger = false
  view.usage.errors.forEach((error, i) => {
    if (error.sessionId === undefined) {
      ledger = true
      items.push({ key: `usage-${i}`, text: t('settings.problem.item', { source: t('settings.problem.usage'), message: error.message }) })
    } else {
      items.push({
        key: `session-${i}`,
        text: t('settings.problem.item', { source: t('settings.problem.session', { session: error.sessionId }), message: error.message }),
      })
    }
  })
  view.pricingErrors.forEach((message, i) => {
    items.push({ key: `pricing-${i}`, text: t('settings.problem.item', { source: t('settings.problem.pricing'), message }) })
  })
  view.budgetErrors.forEach((message, i) => {
    items.push({ key: `budget-${i}`, text: t('settings.problem.item', { source: t('settings.problem.budget'), message }) })
  })
  if (items.length === 0) return null
  return (
    <section className="dsh-tally-settings-part" data-tally="problems">
      <h3>{t('settings.problems')}</h3>
      <ul className="dsh-tally-list">
        {items.map(item => <li key={item.key} className="dsh-tally-error" data-tally="problem">{item.text}</li>)}
      </ul>
      {ledger ? <p className="dsh-tally-hint" data-tally="rebuild-hint">{t('settings.problem.rebuildHint')}</p> : null}
    </section>
  )
}
