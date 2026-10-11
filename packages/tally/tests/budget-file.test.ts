import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Budget } from 'dsh-tally-api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BudgetFile, validateBudget } from '../src/budget-file.js'

let dir: string
let path: string

const monthly: Budget = {
  id: 'b1',
  period: 'month',
  scope: { workspaceId: 'ws-1' },
  limit: { amount: '100', currency: 'CNY' },
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-tally-budget-'))
  path = join(dir, 'budgets.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('BudgetFile', () => {
  it('loads a missing file as empty state', () => {
    const file = BudgetFile.load(path)
    expect(file.budgets()).toEqual([])
    expect(file.fired('b1', 0)).toEqual([])
    expect(file.loadError).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  it('persists put and reloads identically', () => {
    const file = BudgetFile.load(path)
    file.put(monthly)
    file.put({ ...monthly, id: 'b2', period: 'day', scope: {} })
    const reloaded = BudgetFile.load(path)
    expect(reloaded.budgets()).toEqual(file.budgets())
    expect(reloaded.budgets()).toHaveLength(2)
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1)
  })

  it('replaces a budget with the same id', () => {
    const file = BudgetFile.load(path)
    file.put(monthly)
    file.put({ ...monthly, limit: { amount: '200', currency: 'CNY' } })
    expect(BudgetFile.load(path).budgets()).toEqual([{ ...monthly, limit: { amount: '200', currency: 'CNY' } }])
  })

  it('returns copies from budgets()', () => {
    const file = BudgetFile.load(path)
    file.put(monthly)
    file.budgets()[0]!.limit.amount = '1'
    file.budgets().pop()
    expect(file.budgets()).toEqual([monthly])
  })

  it('deletes budgets and their fired records', () => {
    const file = BudgetFile.load(path)
    file.put(monthly)
    file.markFired('b1', 1000, 0.8)
    expect(file.delete('b1')).toBe(true)
    expect(file.delete('b1')).toBe(false)
    const reloaded = BudgetFile.load(path)
    expect(reloaded.budgets()).toEqual([])
    expect(reloaded.fired('b1', 1000)).toEqual([])
  })

  it('persists markFired across reloads', () => {
    const file = BudgetFile.load(path)
    file.put(monthly)
    file.markFired('b1', 1000, 0.8)
    file.markFired('b1', 1000, 0.8)
    file.markFired('b1', 1000, 1)
    expect(BudgetFile.load(path).fired('b1', 1000)).toEqual([0.8, 1])
  })

  it('overwrites the old period when markFired uses a new periodStart', () => {
    const file = BudgetFile.load(path)
    file.markFired('b1', 1000, 0.8)
    file.markFired('b1', 1000, 1)
    file.markFired('b1', 2000, 0.8)
    expect(file.fired('b1', 1000)).toEqual([])
    expect(file.fired('b1', 2000)).toEqual([0.8])
    expect(BudgetFile.load(path).fired('b1', 2000)).toEqual([0.8])
  })

  it('quarantines corrupt JSON and starts empty', () => {
    writeFileSync(path, '{ not json')
    const file = BudgetFile.load(path)
    expect(file.budgets()).toEqual([])
    expect(file.loadError).toBeTruthy()
    expect(existsSync(path)).toBe(false)
    const corrupt = readdirSync(dir).filter((n) => n.startsWith('budgets.json.corrupt-'))
    expect(corrupt).toHaveLength(1)
    expect(readFileSync(join(dir, corrupt[0]!), 'utf8')).toBe('{ not json')
    file.put(monthly)
    expect(BudgetFile.load(path).budgets()).toEqual([monthly])
  })

  it('quarantines structurally invalid content', () => {
    writeFileSync(path, JSON.stringify({ version: 2, budgets: [] }))
    const file = BudgetFile.load(path)
    expect(file.loadError).toBeTruthy()
    expect(readdirSync(dir).some((n) => n.includes('.corrupt-'))).toBe(true)
  })

  it('leaves no temp files after writing', () => {
    const file = BudgetFile.load(path)
    file.put(monthly)
    file.markFired('b1', 1, 1)
    expect(readdirSync(dir)).toEqual(['budgets.json'])
  })
})

describe('validateBudget', () => {
  it('accepts a valid budget', () => {
    expect(validateBudget(monthly)).toEqual([])
    expect(validateBudget({ ...monthly, scope: {} })).toEqual([])
    expect(validateBudget({ ...monthly, limit: { amount: '0.5', currency: 'USD' } })).toEqual([])
  })

  it.each([
    ['zero amount', { ...monthly, limit: { amount: '0', currency: 'CNY' } }],
    ['zero with fraction', { ...monthly, limit: { amount: '0.00', currency: 'CNY' } }],
    ['negative amount', { ...monthly, limit: { amount: '-1', currency: 'CNY' } }],
    ['exponent amount', { ...monthly, limit: { amount: '1e3', currency: 'CNY' } }],
    ['numeric amount', { ...monthly, limit: { amount: 5, currency: 'CNY' } }],
    ['bad period', { ...monthly, period: 'week' }],
    ['bad currency', { ...monthly, limit: { amount: '1', currency: 'EUR' } }],
    ['empty id', { ...monthly, id: '' }],
    ['empty workspaceId', { ...monthly, scope: { workspaceId: '' } }],
    ['missing scope', { id: 'b', period: 'day', limit: { amount: '1', currency: 'CNY' } }],
    ['null', null],
    ['string', 'x'],
  ])('rejects %s', (_name, value) => {
    expect(validateBudget(value).length).toBeGreaterThan(0)
  })
})
