/** Input checks of the settings dialogs, kept free of React so they can be tested on their own. */
import type { Budget } from 'dsh-tally-api'
import { compareDecimal } from '../dashboard/decimal.ts'

export interface BudgetDraft {
  period: Budget['period']
  /** `null` for every workspace. */
  workspaceId: string | null
  amount: string
}

export type BudgetDraftProblem = 'invalid-amount' | 'duplicate'

/** A positive amount with at most two decimals, or why the draft cannot be saved. */
export function validateBudgetDraft(draft: BudgetDraft, existing: readonly Budget[], editingId: string | null): BudgetDraftProblem | null {
  const amount = draft.amount.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(amount) || compareDecimal(amount, '0') <= 0) return 'invalid-amount'
  const clash = existing.some(b =>
    b.id !== editingId && b.period === draft.period && (b.scope.workspaceId ?? null) === draft.workspaceId)
  return clash ? 'duplicate' : null
}
