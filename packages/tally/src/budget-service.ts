import { Service, type Context } from '@deepseek-ai/cordis'
import { addFixed, formatFixed, parseAmount, type Fixed } from 'dsh-pricing-data'
import type { Budget, BudgetAlert, BudgetService, TallyEntry } from 'dsh-tally-api'
import { BudgetFile, validateBudget } from './budget-file.js'
import { periodBounds } from './period.js'

export interface TallyBudgetConfig {
  /** Budget file (budgets plus alert bookkeeping). */
  path: string
  /** IANA time zone whose calendar day or month a budget period follows. */
  timeZone: string
}

/** Alert thresholds as exact ratios `num / den`, in ascending order. */
const THRESHOLDS = [
  { value: 0.8, num: 8n, den: 10n },
  { value: 1, num: 1n, den: 1n },
] as const

/** Mutable runtime state, kept in one plain object because service methods may run on a cordis proxy. */
interface BudgetState {
  readonly file: BudgetFile
  /** Evaluations run one after another through this chain; it never rejects. */
  chain: Promise<void>
  /** Recorded entries not yet evaluated; the next link of the chain takes all of them at once. */
  pending: TallyEntry[]
  disposed: boolean
  /** Budget edits are written one after another through this chain; it never rejects. */
  writes: Promise<void>
  /** Edits accepted by `set`/`remove` whose write has not finished; `list()` shows them already. */
  queued: Array<{ set: Budget } | { remove: string }>
  /** Why the latest budget write failed; cleared by the next successful write. */
  writeError: string | undefined
}

/** Whether two budgets spend over the same period, scope and currency (only the limit amount may differ). */
function sameSelection(a: Budget, b: Budget): boolean {
  return a.period === b.period && a.scope.workspaceId === b.scope.workspaceId && a.limit.currency === b.limit.currency
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `ctx.tallyBudget`: spending limits per day or month with one alert per threshold and period.
 *
 * Every live `tally/recorded` entry with a cost triggers an evaluation of the budgets it
 * affects. Each evaluation re-queries the whole period, so entries that queue up while another
 * evaluation runs are coalesced: a budget is evaluated once per period for the whole batch. Spent amounts come from `ctx.tallyUsage` and are compared with the limit as exact
 * BigInt fixed-point values. A threshold is persisted as fired before its event is emitted, so a
 * restart never repeats an alert; the history that backfill and rebuild write is never evaluated
 * because those entries do not emit `tally/recorded`.
 */
export class TallyBudget extends Service implements BudgetService {
  static inject = ['tallyUsage']

  private readonly timeZone: string
  private readonly state: BudgetState

  constructor(ctx: Context, config: TallyBudgetConfig) {
    super(ctx, 'tallyBudget')
    this.timeZone = config.timeZone
    const state: BudgetState = this.state = {
      file: BudgetFile.load(config.path),
      chain: Promise.resolve(),
      pending: [],
      disposed: false,
      writes: Promise.resolve(),
      queued: [],
      writeError: undefined,
    }

    // Let an evaluation that is already running finish; queued ones see `disposed` and skip.
    ctx.effect(() => async () => {
      state.disposed = true
      await state.chain
      await state.writes
    }, 'tallyBudget lifecycle')

    ctx.on('tally/recorded', (entry: TallyEntry) => this.onRecorded(entry))
  }

  /** The file's budgets with the edits that are still being written applied on top. */
  list(): Budget[] {
    const budgets = this.state.file.budgets()
    for (const op of this.state.queued) {
      if ('set' in op) {
        const i = budgets.findIndex(x => x.id === op.set.id)
        if (i >= 0) budgets[i] = structuredClone(op.set)
        else budgets.push(structuredClone(op.set))
      } else {
        const i = budgets.findIndex(x => x.id === op.remove)
        if (i >= 0) budgets.splice(i, 1)
      }
    }
    return budgets
  }

  /**
   * `BudgetService.set` and `remove` are synchronous, but the file write takes a cross-process lock
   * and is asynchronous. The edit is therefore queued: `list()` shows it at once, the write follows in
   * order, and a failed write is logged and reported by `status().errors` (the edit then disappears
   * from `list()` again).
   */
  set(b: Budget): void {
    const errors = validateBudget(b)
    if (errors.length > 0) throw new Error('tally: invalid budget: ' + errors.join('; '))
    this.enqueue({ set: structuredClone(b) }, () => this.state.file.put(b))
  }

  remove(id: string): void {
    this.enqueue({ remove: id }, async () => { await this.state.file.delete(id) })
  }

  /** Resolves once every edit accepted so far is written and every queued evaluation has finished. */
  async flush(): Promise<void> {
    const state = this.state
    for (;;) {
      const { writes, chain } = state
      await Promise.all([writes, chain])
      if (state.writes === writes && state.chain === chain) return
    }
  }

  status(): { errors: string[] } {
    const { loadError } = this.state.file
    const errors = loadError === undefined ? [] : [`budget file: ${loadError}`]
    if (this.state.writeError !== undefined) errors.push(`budget file write: ${this.state.writeError}`)
    return { errors }
  }

  private enqueue(op: BudgetState['queued'][number], write: () => Promise<void>): void {
    const state = this.state
    state.queued.push(op)
    state.writes = state.writes.then(write).then(
      () => { state.writeError = undefined },
      (error: unknown) => {
        state.writeError = messageOf(error)
        this.ctx.logger.warn(`tally: budget file write failed: ${messageOf(error)}`)
      },
    ).then(() => {
      state.queued.splice(state.queued.indexOf(op), 1)
    })
  }

  private onRecorded(entry: TallyEntry): void {
    if (entry.cost === null) return
    const state = this.state
    state.pending.push(entry)
    state.chain = state.chain
      .then(() => (state.disposed ? undefined : this.drain()))
      .catch((error: unknown) => {
        this.ctx.logger.warn(`tally: budget evaluation failed: ${messageOf(error)}`)
      })
  }

  /** Evaluate everything queued so far; later links of the chain then find nothing pending. */
  private async drain(): Promise<void> {
    const batch = this.state.pending.splice(0)
    if (batch.length === 0) return
    // Edits made before these entries were recorded must be on disk when the evaluation reads the file.
    await this.state.writes
    for (const budget of this.list()) {
      // The latest entry of each period stands for all earlier ones of that period (the query
      // covers them anyway). Older periods go first so a newer period's alert record cannot
      // make an older period's crossing look stale.
      const latest = new Map<number, number>()
      for (const entry of batch) {
        if (budget.scope.workspaceId !== undefined && budget.scope.workspaceId !== entry.workspaceId) continue
        if (budget.limit.currency !== entry.cost!.currency) continue
        const { start } = periodBounds(budget.period, entry.at, this.timeZone)
        latest.set(start, Math.max(latest.get(start) ?? entry.at, entry.at))
      }
      for (const [, at] of [...latest].sort(([a], [b]) => a - b)) {
        if (this.state.disposed) return
        // One failing evaluation must not cost the rest of the batch.
        try {
          await this.evaluateBudget(budget, at)
        } catch (error) {
          this.ctx.logger.warn(`tally: budget evaluation failed: ${messageOf(error)}`)
        }
      }
    }
  }

  private async evaluateBudget(budget: Budget, at: number): Promise<void> {
    const { start, end } = periodBounds(budget.period, at, this.timeZone)
    // The file keeps one alert record per budget; an entry from an earlier period must neither
    // alert nor overwrite the record of the current one.
    const recorded = this.state.file.lastFiredPeriod(budget.id)
    if (recorded !== undefined && start < recorded) return
    const workspaceId = budget.scope.workspaceId
    const groups = await this.ctx.tallyUsage.query({
      from: start,
      to: end,
      groupBy: 'day',
      ...(workspaceId === undefined ? {} : { filter: { workspaceId } }),
      tz: this.timeZone,
    })
    let spent: Fixed = { units: 0n }
    for (const group of groups) {
      for (const money of group.cost) {
        if (money.currency === budget.limit.currency) spent = addFixed(spent, parseAmount(money.amount))
      }
    }
    // The budget may have been removed or replaced while the query was running.
    const current = this.list().find(b => b.id === budget.id)
    if (current === undefined || !sameSelection(current, budget)) return
    const limit = parseAmount(current.limit.amount)
    for (const t of THRESHOLDS) {
      // spent >= limit * num / den, without division.
      if (spent.units * t.den < limit.units * t.num) continue
      if (this.state.file.fired(budget.id, start).includes(t.value)) continue
      // Persist first: if emitting fails or the process dies, the alert is never repeated.
      await this.state.file.markFired(budget.id, start, t.value)
      this.announce({
        budgetId: budget.id,
        threshold: t.value,
        spent: { amount: formatFixed(spent), currency: current.limit.currency },
        limit: { ...current.limit },
        periodStart: start,
      })
    }
  }

  private announce(alert: BudgetAlert): void {
    try {
      this.ctx.emit('tally/budget-crossed', alert)
    } catch (error) {
      this.ctx.logger.warn(`tally/budget-crossed listener failed for ${alert.budgetId}: ${messageOf(error)}`)
    }
  }
}
