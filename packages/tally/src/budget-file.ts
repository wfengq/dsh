import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseDecimal } from 'dsh-pricing-data'
import type { Budget } from 'dsh-tally-api'

type Threshold = 0.8 | 1

interface FiredRecord {
  periodStart: number
  thresholds: Threshold[]
}

interface BudgetFileData {
  version: 1
  budgets: Budget[]
  fired: Record<string, FiredRecord>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Returns a list of problems; empty means the budget is valid. */
export function validateBudget(b: unknown): string[] {
  if (!isRecord(b)) return ['budget must be an object']
  const errors: string[] = []
  if (typeof b.id !== 'string' || b.id === '') errors.push('id must be a non-empty string')
  if (b.period !== 'day' && b.period !== 'month') errors.push("period must be 'day' or 'month'")
  if (!isRecord(b.scope)) {
    errors.push('scope must be an object')
  } else if (
    b.scope.workspaceId !== undefined &&
    (typeof b.scope.workspaceId !== 'string' || b.scope.workspaceId === '')
  ) {
    errors.push('scope.workspaceId must be a non-empty string when present')
  }
  if (!isRecord(b.limit)) {
    errors.push('limit must be an object')
  } else {
    if (b.limit.currency !== 'CNY' && b.limit.currency !== 'USD') {
      errors.push("limit.currency must be 'CNY' or 'USD'")
    }
    let positive = false
    try {
      positive = parseDecimal(b.limit.amount as string).units > 0n
    } catch {
      // handled below
    }
    if (!positive) errors.push('limit.amount must be a decimal string greater than 0')
  }
  return errors
}

function parseData(raw: unknown): BudgetFileData {
  if (!isRecord(raw) || raw.version !== 1) throw new Error('unsupported budget file format')
  if (!Array.isArray(raw.budgets)) throw new Error('budgets must be an array')
  const budgets: Budget[] = []
  for (const b of raw.budgets) {
    const errors = validateBudget(b)
    if (errors.length > 0) throw new Error(`invalid budget: ${errors.join('; ')}`)
    budgets.push(structuredClone(b as Budget))
  }
  const fired: Record<string, FiredRecord> = {}
  if (raw.fired !== undefined) {
    if (!isRecord(raw.fired)) throw new Error('fired must be an object')
    for (const [id, rec] of Object.entries(raw.fired)) {
      if (
        !isRecord(rec) ||
        typeof rec.periodStart !== 'number' ||
        !Array.isArray(rec.thresholds) ||
        !rec.thresholds.every((t) => t === 0.8 || t === 1)
      ) {
        throw new Error(`invalid fired record for ${id}`)
      }
      fired[id] = { periodStart: rec.periodStart, thresholds: [...(rec.thresholds as Threshold[])] }
    }
  }
  return { version: 1, budgets, fired }
}

/** Budgets plus per-period alert bookkeeping, persisted atomically on every change. */
export class BudgetFile {
  /** Why the file was quarantined on load, if it was. */
  loadError: string | undefined

  private constructor(
    private readonly path: string,
    private data: BudgetFileData,
  ) {}

  static load(path: string): BudgetFile {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new BudgetFile(path, { version: 1, budgets: [], fired: {} })
      }
      throw error
    }
    try {
      return new BudgetFile(path, parseData(JSON.parse(text)))
    } catch (error) {
      const file = new BudgetFile(path, { version: 1, budgets: [], fired: {} })
      file.loadError = error instanceof Error ? error.message : String(error)
      renameSync(path, `${path}.corrupt-${Date.now()}`)
      return file
    }
  }

  budgets(): Budget[] {
    return structuredClone(this.data.budgets)
  }

  put(b: Budget): void {
    const errors = validateBudget(b)
    if (errors.length > 0) throw new Error(`tally: invalid budget: ${errors.join('; ')}`)
    const copy = structuredClone(b)
    const i = this.data.budgets.findIndex((x) => x.id === b.id)
    if (i >= 0) this.data.budgets[i] = copy
    else this.data.budgets.push(copy)
    this.save()
  }

  delete(id: string): boolean {
    const i = this.data.budgets.findIndex((x) => x.id === id)
    if (i < 0) return false
    this.data.budgets.splice(i, 1)
    delete this.data.fired[id]
    this.save()
    return true
  }

  fired(budgetId: string, periodStart: number): Threshold[] {
    const rec = this.data.fired[budgetId]
    return rec && rec.periodStart === periodStart ? [...rec.thresholds] : []
  }

  markFired(budgetId: string, periodStart: number, t: Threshold): void {
    const rec = this.data.fired[budgetId]
    if (rec && rec.periodStart === periodStart) {
      if (rec.thresholds.includes(t)) return
      rec.thresholds.push(t)
    } else {
      this.data.fired[budgetId] = { periodStart, thresholds: [t] }
    }
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`)
    renameSync(tmp, this.path)
  }
}
