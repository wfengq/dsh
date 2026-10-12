import { describe, expect, it } from 'vitest'
import type { Budget } from 'dsh-tally-api'
import { validateBudgetDraft } from '../src/client/settings/validate.ts'

const draft = (amount: string, period: 'day' | 'month' = 'day', workspaceId: string | null = null) => ({ period, workspaceId, amount })
const existing: Budget[] = [{ id: 'b1', period: 'day', scope: {}, limit: { amount: '10', currency: 'CNY' } }]

describe('validateBudgetDraft', () => {
  it('rejects zero, too many decimals and non-numbers', () => {
    expect(validateBudgetDraft(draft('0'), [], null)).toBe('invalid-amount')
    expect(validateBudgetDraft(draft('0.00'), [], null)).toBe('invalid-amount')
    expect(validateBudgetDraft(draft('1.234'), [], null)).toBe('invalid-amount')
    expect(validateBudgetDraft(draft('abc'), [], null)).toBe('invalid-amount')
    expect(validateBudgetDraft(draft('1e3'), [], null)).toBe('invalid-amount')
    expect(validateBudgetDraft(draft(''), [], null)).toBe('invalid-amount')
  })

  it('accepts a positive amount with up to two decimals', () => {
    expect(validateBudgetDraft(draft('10.5'), [], null)).toBeNull()
    expect(validateBudgetDraft(draft('0.01'), [], null)).toBeNull()
  })

  it('refuses a second budget with the same period and scope, but not when editing that budget', () => {
    expect(validateBudgetDraft(draft('5'), existing, null)).toBe('duplicate')
    expect(validateBudgetDraft(draft('5'), existing, 'b1')).toBeNull()
    expect(validateBudgetDraft(draft('5', 'month'), existing, null)).toBeNull()
    expect(validateBudgetDraft(draft('5', 'day', '/w'), existing, null)).toBeNull()
  })
})
