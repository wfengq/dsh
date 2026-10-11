import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Budget } from 'dsh-tally-api'
import * as atomicWrite from '@deepseek-ai/dsh-atomic-write'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BudgetFile, validateBudget } from '../src/budget-file.js'

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const real = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...real, writeFileAtomic: vi.fn(real.writeFileAtomic) }
})

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
  it('loads a missing file as empty state', async () => {
    const file = BudgetFile.load(path)
    expect(file.budgets()).toEqual([])
    expect(file.fired('b1', 0)).toEqual([])
    expect(file.loadError).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  it('persists put and reloads identically', async () => {
    const file = BudgetFile.load(path)
    await file.put(monthly)
    await file.put({ ...monthly, id: 'b2', period: 'day', scope: {} })
    const reloaded = BudgetFile.load(path)
    expect(reloaded.budgets()).toEqual(file.budgets())
    expect(reloaded.budgets()).toHaveLength(2)
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1)
  })

  it('replaces a budget with the same id', async () => {
    const file = BudgetFile.load(path)
    await file.put(monthly)
    await file.put({ ...monthly, limit: { amount: '200', currency: 'CNY' } })
    expect(BudgetFile.load(path).budgets()).toEqual([{ ...monthly, limit: { amount: '200', currency: 'CNY' } }])
  })

  it('returns copies from budgets()', async () => {
    const file = BudgetFile.load(path)
    await file.put(monthly)
    file.budgets()[0]!.limit.amount = '1'
    file.budgets().pop()
    expect(file.budgets()).toEqual([monthly])
  })

  it('deletes budgets and their fired records', async () => {
    const file = BudgetFile.load(path)
    await file.put(monthly)
    await file.markFired('b1', 1000, 0.8)
    expect(await file.delete('b1')).toBe(true)
    expect(await file.delete('b1')).toBe(false)
    const reloaded = BudgetFile.load(path)
    expect(reloaded.budgets()).toEqual([])
    expect(reloaded.fired('b1', 1000)).toEqual([])
  })

  it('persists markFired across reloads', async () => {
    const file = BudgetFile.load(path)
    await file.put(monthly)
    await file.markFired('b1', 1000, 0.8)
    await file.markFired('b1', 1000, 0.8)
    await file.markFired('b1', 1000, 1)
    expect(BudgetFile.load(path).fired('b1', 1000)).toEqual([0.8, 1])
  })

  it('overwrites the old period when markFired uses a new periodStart', async () => {
    const file = BudgetFile.load(path)
    await file.put(monthly)
    await file.markFired('b1', 1000, 0.8)
    await file.markFired('b1', 1000, 1)
    await file.markFired('b1', 2000, 0.8)
    expect(file.fired('b1', 1000)).toEqual([])
    expect(file.fired('b1', 2000)).toEqual([0.8])
    expect(BudgetFile.load(path).fired('b1', 2000)).toEqual([0.8])
  })

  it('reads a corrupt file as empty without touching it, then quarantines it under the lock on the next write', async () => {
    writeFileSync(path, '{ not json')
    const file = BudgetFile.load(path)
    expect(file.budgets()).toEqual([])
    expect(file.loadError).toBeTruthy()
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
    expect(readdirSync(dir).some((n) => n.includes('.corrupt-'))).toBe(false)
    await file.put(monthly)
    expect(existsSync(path)).toBe(true)
    const corrupt = readdirSync(dir).filter((n) => n.startsWith('budgets.json.corrupt-'))
    expect(corrupt).toHaveLength(1)
    expect(readFileSync(join(dir, corrupt[0]!), 'utf8')).toBe('{ not json')
    await file.put(monthly)
    expect(BudgetFile.load(path).budgets()).toEqual([monthly])
  })

  it('treats structurally invalid content like a corrupt file', async () => {
    writeFileSync(path, JSON.stringify({ version: 2, budgets: [] }))
    const file = BudgetFile.load(path)
    expect(file.loadError).toBeTruthy()
    expect(readdirSync(dir).some((n) => n.includes('.corrupt-'))).toBe(false)
    await file.put(monthly)
    expect(readdirSync(dir).some((n) => n.includes('.corrupt-'))).toBe(true)
  })

  it('rejects an invalid budget in put without touching the file', async () => {
    const file = BudgetFile.load(path)
    await file.put(monthly)
    const before = readFileSync(path, 'utf8')
    await expect(file.put({ ...monthly, limit: { amount: '0', currency: 'CNY' } })).rejects.toThrow(/^tally: invalid budget: .+/)
    await expect(file.put({ ...monthly, period: 'week' } as unknown as Budget)).rejects.toThrow('tally: invalid budget: ')
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(file.budgets()).toEqual([monthly])
  })

  it('leaves no temp files after writing', async () => {
    const file = BudgetFile.load(path)
    await file.put(monthly)
    await file.markFired('b1', 1, 1)
    expect(readdirSync(dir)).toEqual(['budgets.json'])
  })
})

describe('BudgetFile across processes', () => {
  const other = (id: string): Budget => ({ ...monthly, id })

  it('keeps both writers\' budgets and alert records', async () => {
    const a = BudgetFile.load(path)
    const b = BudgetFile.load(path)
    await a.put(other('x'))
    await b.put(other('y'))
    await b.markFired('y', 1000, 0.8)
    const reloaded = BudgetFile.load(path)
    expect(reloaded.budgets().map((x) => x.id).sort()).toEqual(['x', 'y'])
    expect(reloaded.fired('y', 1000)).toEqual([0.8])
  })

  it('never rolls an alert record back to an older period', async () => {
    const a = BudgetFile.load(path)
    const b = BudgetFile.load(path)
    await a.put(monthly)
    expect(await a.markFired('b1', 2000, 1)).toBe(true)
    expect(await b.markFired('b1', 1000, 0.8)).toBe(false)
    const reloaded = BudgetFile.load(path)
    expect(reloaded.lastFiredPeriod('b1')).toBe(2000)
    expect(reloaded.fired('b1', 2000)).toEqual([1])
    expect(reloaded.fired('b1', 1000)).toEqual([])
  })

  it('unions thresholds of the same period written by two instances', async () => {
    const a = BudgetFile.load(path)
    const b = BudgetFile.load(path)
    await a.put(monthly)
    expect(await a.markFired('b1', 1000, 0.8)).toBe(true)
    expect(await b.markFired('b1', 1000, 1)).toBe(true)
    expect(await b.markFired('b1', 1000, 1)).toBe(false)
    expect(await a.markFired('b1', 1000, 0.8)).toBe(false)
    expect(BudgetFile.load(path).fired('b1', 1000)).toEqual([0.8, 1])
  })

  it('loses nothing when two instances put concurrently', async () => {
    const a = BudgetFile.load(path)
    const b = BudgetFile.load(path)
    const writes: Promise<void>[] = []
    for (let i = 0; i < 20; i++) {
      writes.push(a.put(other(`a${i}`)), b.put(other(`b${i}`)))
    }
    await Promise.all(writes)
    expect(BudgetFile.load(path).budgets()).toHaveLength(40)
  })

  it('shows another instance\'s write without calling load', async () => {
    const a = BudgetFile.load(path)
    const b = BudgetFile.load(path)
    expect(b.budgets()).toEqual([])
    await a.put(monthly)
    expect(b.budgets()).toEqual([monthly])
    await a.delete('b1')
    expect(b.budgets()).toEqual([])
  })

  it('keeps the last good state when another process leaves a corrupt file', async () => {
    const a = BudgetFile.load(path)
    await a.put(monthly)
    writeFileSync(path, '{ not json, and longer than before')
    expect(a.budgets()).toEqual([monthly])
    expect(a.loadError).toBeTruthy()
    expect(readFileSync(path, 'utf8')).toBe('{ not json, and longer than before')
  })

  it('does not record an alert for a budget that is not on disk', async () => {
    const file = BudgetFile.load(path)
    expect(await file.markFired('ghost', 1, 1)).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  it('leaves memory untouched when the write fails', async () => {
    const file = BudgetFile.load(path)
    await file.put(monthly)
    vi.mocked(atomicWrite.writeFileAtomic).mockRejectedValueOnce(new Error('disk full'))
    await expect(file.put(other('z'))).rejects.toThrow('disk full')
    vi.mocked(atomicWrite.writeFileAtomic).mockRejectedValueOnce(new Error('disk full'))
    await expect(file.markFired('b1', 5, 1)).rejects.toThrow('disk full')
    expect(file.budgets().map((x) => x.id)).not.toContain('z')
    expect(file.fired('b1', 5)).toEqual([])
  })
})

describe('validateBudget', () => {
  it('accepts a valid budget', async () => {
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
