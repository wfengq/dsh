import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { Budget, BudgetAlert } from 'dsh-tally-api'
import { budgetRatio } from './budget-progress.ts'
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
    /** The configured budgets, which name the alert's budget; `null` until loaded. */
    budgets: Snapshot<readonly Budget[] | null>
  }
  dismissAlert: (alert: BudgetAlert) => void
  openDashboard: (sessionId?: string) => void
  canOpenDashboard: () => boolean
}

export type BudgetToastProps = InjectFace<BudgetToastInjected> & { t: T }

const alertKey = (a: BudgetAlert) => `${a.budgetId}\u0000${a.threshold}\u0000${a.periodStart}`

/** "今日" / "本月（ws-a）"; a neutral word ("" in Chinese, "The" in English) for a budget this window does not know. */
function periodName(budget: Budget | undefined, t: T): string {
  if (budget === undefined) return t('alert.period.any')
  const period = t(budget.period === 'day' ? 'alert.period.day' : 'alert.period.month')
  return budget.scope.workspaceId === undefined ? period : `${period}（${budget.scope.workspaceId}）`
}

/** Shows the oldest pending budget alert; once the toast is done it is dismissed and the next one shows. */
export function BudgetToast({ useElements, useAlerts, useBudgets, dismissAlert, openDashboard, canOpenDashboard, t }: BudgetToastProps): ReactNode {
  const enabled = useElements((e: Elements) => e.budgetToast)
  const canOpen = useElements((e: Elements) => e.sidebarTab) && canOpenDashboard()
  const alert = useAlerts((list: readonly BudgetAlert[]): BudgetAlert | undefined => list[0])
  const budget = useBudgets((list: readonly Budget[] | null): Budget | undefined => list?.find(b => b.id === alert?.budgetId))
  if (!enabled || alert === undefined) return null
  const amounts = { period: periodName(budget, t), spent: formatMoney(alert.spent, FORMAT_LOCALE), limit: formatMoney(alert.limit, FORMAT_LOCALE) }
  const text = alert.threshold === 1
    ? t('alert.over', amounts)
    : t('alert.used', { ...amounts, pct: Math.floor(budgetRatio(alert.spent, alert.limit) * 100) })
  return (
    <Toast
      key={alertKey(alert)}
      text={text}
      holdMs={HOLD_MS}
      actions={canOpen ? [{ label: t('alert.view'), onClick: () => { openDashboard() } }] : []}
      onDone={() => { dismissAlert(alert) }}
    />
  )
}
