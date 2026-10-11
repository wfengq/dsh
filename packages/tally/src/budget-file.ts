import { mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
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
  const fired = firedMap()
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

/** Identity of the file content last read or written; a change means another writer got there. */
interface Signature {
  mtimeMs: number
  size: number
}

interface DiskState {
  data: BudgetFileData
  signature: Signature | undefined
  /** Set when the file was unusable and has been moved aside. */
  loadError?: string
}

function emptyData(): BudgetFileData {
  return { version: 1, budgets: [], fired: firedMap() }
}

/**
 * Alert records keyed by budget id. The map has no prototype, so ids such as `toString` or
 * `__proto__` are plain keys; every lookup still goes through `Object.hasOwn`.
 */
function firedMap(): Record<string, FiredRecord> {
  return Object.create(null) as Record<string, FiredRecord>
}

function firedOf(data: BudgetFileData, budgetId: string): FiredRecord | undefined {
  return Object.hasOwn(data.fired, budgetId) ? data.fired[budgetId] : undefined
}

/** A deep copy that keeps `fired` prototype-free (`structuredClone` would give it `Object.prototype`). */
function cloneData(data: BudgetFileData): BudgetFileData {
  const fired = firedMap()
  for (const id of Object.keys(data.fired)) {
    const rec = data.fired[id]!
    fired[id] = { periodStart: rec.periodStart, thresholds: [...rec.thresholds] }
  }
  return { version: 1, budgets: structuredClone(data.budgets), fired }
}

function signatureOf(path: string): Signature | undefined {
  try {
    const { mtimeMs, size } = statSync(path)
    return { mtimeMs, size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Read the file; a corrupt one is reported as `loadError` and read as empty. It is moved aside only
 * with `quarantine`, which callers pass solely while holding the writer lock: without the lock the
 * rename could take away a file another process has just replaced with a good one.
 */
function readDisk(path: string, quarantine: boolean): DiskState {
  let text: string
  let signature: Signature | undefined
  try {
    signature = signatureOf(path)
    if (signature === undefined) return { data: emptyData(), signature }
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: emptyData(), signature: undefined }
    throw error
  }
  try {
    return { data: parseData(JSON.parse(text)), signature }
  } catch (error) {
    if (quarantine) renameSync(path, `${path}.corrupt-${Date.now()}`)
    return {
      data: emptyData(),
      signature: quarantine ? undefined : signature,
      loadError: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Budgets plus per-period alert bookkeeping, shared by every dsh process using the same file.
 *
 * Every write runs under a cross-process lock: it re-reads the file, merges its own change into what
 * it finds and replaces the file atomically, so concurrent writers never lose each other's changes.
 * Reads compare the file's `mtimeMs` and size with the last ones seen and reload on a change. Memory
 * is only updated after a write succeeded.
 */
export class BudgetFile {
  /** Why the file was found unusable (it is moved aside by the next write), if it was. */
  loadError: string | undefined

  /** Tail of this instance's write queue; it never rejects. */
  private writes: Promise<void> = Promise.resolve()

  private constructor(
    private readonly path: string,
    private data: BudgetFileData,
    private signature: Signature | undefined,
  ) {}

  static load(path: string): BudgetFile {
    const state = readDisk(path, false)
    const file = new BudgetFile(path, state.data, state.signature)
    file.loadError = state.loadError
    return file
  }

  budgets(): Budget[] {
    this.reloadIfChanged()
    return structuredClone(this.data.budgets)
  }

  async put(b: Budget): Promise<void> {
    const errors = validateBudget(b)
    if (errors.length > 0) throw new Error(`tally: invalid budget: ${errors.join('; ')}`)
    const copy = structuredClone(b)
    await this.update((data) => {
      const i = data.budgets.findIndex((x) => x.id === b.id)
      if (i >= 0) data.budgets[i] = copy
      else data.budgets.push(copy)
      return true
    })
  }

  async delete(id: string): Promise<boolean> {
    return this.update((data) => {
      const i = data.budgets.findIndex((x) => x.id === id)
      if (i < 0) return false
      data.budgets.splice(i, 1)
      delete data.fired[id]
      return true
    })
  }

  fired(budgetId: string, periodStart: number): Threshold[] {
    this.reloadIfChanged()
    const rec = firedOf(this.data, budgetId)
    return rec && rec.periodStart === periodStart ? [...rec.thresholds] : []
  }

  /** Start of the period the budget's alerts were last recorded for, if any alert was ever recorded. */
  lastFiredPeriod(budgetId: string): number | undefined {
    this.reloadIfChanged()
    return firedOf(this.data, budgetId)?.periodStart
  }

  /**
   * Record an alert. Resolves `true` only when this call changed the file, so exactly one caller
   * (process) gets to announce a given budget, period and threshold; it is `false` when the budget is gone,
   * the threshold is already recorded or a newer period is. A newer period on disk wins, the same period gets the union of thresholds.
   */
  async markFired(budgetId: string, periodStart: number, t: Threshold): Promise<boolean> {
    return this.update((data) => {
      if (!data.budgets.some((b) => b.id === budgetId)) return false
      const rec = firedOf(data, budgetId)
      if (rec === undefined || rec.periodStart < periodStart) {
        data.fired[budgetId] = { periodStart, thresholds: [t] }
        return true
      }
      if (rec.periodStart > periodStart || rec.thresholds.includes(t)) return false
      rec.thresholds.push(t)
      return true
    })
  }

  private reloadIfChanged(): void {
    let signature: Signature | undefined
    try {
      signature = signatureOf(this.path)
    } catch {
      return // unreadable right now: keep what we have
    }
    if (signature?.mtimeMs === this.signature?.mtimeMs && signature?.size === this.signature?.size) return
    try {
      const state = readDisk(this.path, false)
      this.signature = state.signature
      if (state.loadError !== undefined) {
        this.loadError = state.loadError // a corrupt file keeps the last good state until a writer replaces it
      } else {
        this.data = state.data
        this.loadError = undefined // the file is readable again: the problem is gone
      }
    } catch {
      // keep the previous state; the next read or write tries again
    }
  }

  /**
   * Run `mutate` on a fresh copy of the file content under the lock; when it reports a change, write the
   * result and only then adopt it. Returns what `mutate` returned.
   */
  private update(mutate: (data: BudgetFileData) => boolean): Promise<boolean> {
    // One writer per instance at a time, so a burst of writes queues here instead of all polling the lock.
    const run = this.writes.then(() => this.locked(mutate))
    this.writes = run.then(() => undefined, () => undefined)
    return run
  }

  private async locked(mutate: (data: BudgetFileData) => boolean): Promise<boolean> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(this.path, async () => {
      const state = readDisk(this.path, true)
      if (state.loadError !== undefined) this.loadError = state.loadError
      const next = cloneData(state.data)
      const changed = mutate(next)
      if (!changed) {
        this.data = state.data
        this.signature = state.signature
        return false
      }
      await writeFileAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      this.data = next
      this.signature = signatureOf(this.path)
      // A good file is on disk now (any corrupt one was moved aside above).
      this.loadError = undefined
      return true
    }, {})
  }
}
