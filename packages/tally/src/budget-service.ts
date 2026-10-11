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
    }

    // Let an evaluation that is already running finish; queued ones see `disposed` and skip.
    ctx.effect(() => async () => {
      state.disposed = true
      await state.chain
    }, 'tallyBudget lifecycle')

    ctx.on('tally/recorded', (entry: TallyEntry) => this.onRecorded(entry))
  }

  list(): Budget[] {
    return this.state.file.budgets()
  }

  set(b: Budget): void {
    const errors = validateBudget(b)
    if (errors.length > 0) throw new Error('tally: invalid budget: ' + errors.join('; '))
    this.state.file.put(b)
  }

  remove(id: string): void {
    this.state.file.delete(id)
  }

  status(): { errors: string[] } {
    const { loadError } = this.state.file
    return { errors: loadError === undefined ? [] : [`budget file: ${loadError}`] }
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
    for (const budget of this.state.file.budgets()) {
      // The latest entry of each period stands for all earlier ones of that period (the query
      // covers them anyway); periods keep the order in which their last entry arrived.
      const latest = new Map<number, number>()
      for (const entry of batch) {
        if (budget.scope.workspaceId !== undefined && budget.scope.workspaceId !== entry.workspaceId) continue
        if (budget.limit.currency !== entry.cost!.currency) continue
        const { start } = periodBounds(budget.period, entry.at, this.timeZone)
        latest.delete(start)
        latest.set(start, entry.at)
      }
      for (const at of latest.values()) {
        if (this.state.disposed) return
        await this.evaluateBudget(budget, at)
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
    const current = this.state.file.budgets().find(b => b.id === budget.id)
    if (current === undefined || !sameSelection(current, budget)) return
    const limit = parseAmount(current.limit.amount)
    for (const t of THRESHOLDS) {
      // spent >= limit * num / den, without division.
      if (spent.units * t.den < limit.units * t.num) continue
      if (this.state.file.fired(budget.id, start).includes(t.value)) continue
      // Persist first: if emitting fails or the process dies, the alert is never repeated.
      this.state.file.markFired(budget.id, start, t.value)
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
