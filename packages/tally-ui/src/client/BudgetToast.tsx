import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { BudgetAlert } from 'dsh-tally-api'
import type { Elements } from './elements.ts'
import { formatMoney } from './format.ts'
import { FORMAT_LOCALE, type T } from './labels.ts'
import type { Snapshot } from './store.ts'

/** How long a budget alert stays fully visible: it names a budget and two amounts. */
const HOLD_MS = 8000

/** What the registration hands the budget toast. */
export interface BudgetToastInjected {
  hooks: {
    elements: Snapshot<Elements>
    alerts: Snapshot<readonly BudgetAlert[]>
  }
  dismissAlert: (alert: BudgetAlert) => void
}

export type BudgetToastProps = InjectFace<BudgetToastInjected> & { t: T }

const alertKey = (a: BudgetAlert) => `${a.budgetId}\u0000${a.threshold}\u0000${a.periodStart}`

/** Shows the oldest pending budget alert; once the toast is done it is dismissed and the next one shows. */
export function BudgetToast({ useElements, useAlerts, dismissAlert, t }: BudgetToastProps): ReactNode {
  const enabled = useElements((e: Elements) => e.budgetToast)
  const alert = useAlerts((list: readonly BudgetAlert[]): BudgetAlert | undefined => list[0])
  if (!enabled || alert === undefined) return null
  const text = t(alert.threshold === 1 ? 'alert.reached100' : 'alert.reached80', {
    budget: alert.budgetId,
    spent: formatMoney(alert.spent, FORMAT_LOCALE),
    limit: formatMoney(alert.limit, FORMAT_LOCALE),
  })
  return <Toast key={alertKey(alert)} text={text} holdMs={HOLD_MS} onDone={() => { dismissAlert(alert) }} />
}
