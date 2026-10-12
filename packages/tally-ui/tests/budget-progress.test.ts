import { describe, expect, it } from 'vitest'
import type { Budget, Money, UsageGroup } from 'dsh-tally-api'
import { budgetRatio, budgetTone, pickDockBudget, spentIn } from '../src/client/budget-progress.ts'

const cny = (amount: string): Money => ({ amount, currency: 'CNY' })
const groupWith = (cost: Money[]): UsageGroup => ({
  key: 'k', tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cost, requestCount: 1, unpricedCount: 0, unknownUsageCount: 0,
})
const budget = (id: string, period: 'day' | 'month', limit: string): Budget => ({ id, period, scope: {}, limit: cny(limit) })

describe('budget progress', () => {
  it('budgetTone thresholds', () => {
    expect(budgetTone(0.79)).toBe('normal')
    expect(budgetTone(0.8)).toBe('warn')
    expect(budgetTone(0.999)).toBe('warn')
    expect(budgetTone(1)).toBe('over')
    expect(budgetTone(1.5)).toBe('over')
  })

  it('budgetRatio uses fixed point', () => {
    expect(budgetRatio(cny('3.2'), cny('10'))).toBeCloseTo(0.32)
    expect(budgetRatio(cny('0.000000000000000001'), cny('1'))).toBeGreaterThanOrEqual(0)
    expect(budgetRatio(cny('102'), cny('100'))).toBeCloseTo(1.02)
  })

  it('spentIn falls back to zero in the budget currency', () => {
    expect(spentIn(groupWith([cny('5')]), 'USD')).toEqual({ amount: '0', currency: 'USD' })
    expect(spentIn(groupWith([cny('5'), { amount: '2', currency: 'USD' }]), 'USD')).toEqual({ amount: '2', currency: 'USD' })
    expect(spentIn(null, 'CNY')).toEqual(cny('0'))
  })

  it('pickDockBudget picks the highest ratio, day first on ties', () => {
    const day = budget('d', 'day', '10')
    const month = budget('m', 'month', '100')
    expect(pickDockBudget([month, day], { d: cny('5'), m: cny('50') })?.budget.id).toBe('d')
    const picked = pickDockBudget([day, month], { d: cny('5'), m: cny('90') })
    expect(picked?.budget.id).toBe('m')
    expect(picked?.spent).toEqual(cny('90'))
    expect(picked?.ratio).toBeCloseTo(0.9)
  })

  it('pickDockBudget treats a budget without spend yet as zero', () => {
    expect(pickDockBudget([budget('d', 'day', '10')], {})?.ratio).toBe(0)
  })

  it('pickDockBudget returns null without budgets', () => {
    expect(pickDockBudget([], {})).toBeNull()
  })
})
