/** Budget progress shown by the dock, the settings card and the dashboard overview. */
import type { Budget, Currency, Money, UsageGroup } from 'dsh-tally-api'
import { ratioDecimal } from './dashboard/decimal.ts'

export type BudgetTone = 'normal' | 'warn' | 'over'

/** Share of the limit already spent; both amounts are in the budget's currency. */
export function budgetRatio(spent: Money, limit: Money): number {
  return ratioDecimal(spent.amount, limit.amount)
}

/** Below 80 % normal, from 80 % warn, from 100 % over: the thresholds budget alerts fire at. */
export function budgetTone(ratio: number): BudgetTone {
  return ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'normal'
}

/**
 * Spend of a group in one currency. Amounts are never converted, so spend in another currency does
 * not count against the budget and a group without this currency has spent nothing in it.
 */
export function spentIn(group: UsageGroup | null, currency: Currency): Money {
  return group?.cost.find(m => m.currency === currency) ?? { amount: '0', currency }
}

/** The budget closest to (or furthest past) its limit; a daily budget wins a tie. */
export function pickDockBudget(
  budgets: readonly Budget[],
  spend: Readonly<Record<string, Money>>,
): { budget: Budget; spent: Money; ratio: number } | null {
  let best: { budget: Budget; spent: Money; ratio: number } | null = null
  for (const budget of budgets) {
    const spent = spend[budget.id] ?? { amount: '0', currency: budget.limit.currency }
    const ratio = budgetRatio(spent, budget.limit)
    if (best === null || ratio > best.ratio || (ratio === best.ratio && budget.period === 'day' && best.budget.period !== 'day')) {
      best = { budget, spent, ratio }
    }
  }
  return best
}
