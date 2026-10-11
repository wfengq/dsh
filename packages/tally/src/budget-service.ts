import { Service, type Context } from '@deepseek-ai/cordis'
import { addFixed, formatFixed, parseDecimal, type Fixed } from 'dsh-pricing-data'
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
  /** Evaluations of recorded entries run one after another through this chain; it never rejects. */
  chain: Promise<void>
  disposed: boolean
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `ctx.tallyBudget`: spending limits per day or month with one alert per threshold and period.
 *
 * Every live `tally/recorded` entry with a cost triggers an evaluation of the budgets it
 * affects. Spent amounts come from `ctx.tallyUsage` and are compared with the limit as exact
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
    state.chain = state.chain
      .then(() => (state.disposed ? undefined : this.evaluate(entry)))
      .catch((error: unknown) => {
        this.ctx.logger.warn(`tally: budget evaluation failed: ${messageOf(error)}`)
      })
  }

  private async evaluate(entry: TallyEntry): Promise<void> {
    const currency = entry.cost!.currency
    for (const budget of this.state.file.budgets()) {
      if (this.state.disposed) return
      if (budget.scope.workspaceId !== undefined && budget.scope.workspaceId !== entry.workspaceId) continue
      if (budget.limit.currency !== currency) continue
      await this.evaluateBudget(budget, entry.at)
    }
  }

  private async evaluateBudget(budget: Budget, at: number): Promise<void> {
    const { start, end } = periodBounds(budget.period, at, this.timeZone)
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
        if (money.currency === budget.limit.currency) spent = addFixed(spent, parseDecimal(money.amount))
      }
    }
    const limit = parseDecimal(budget.limit.amount)
    for (const t of THRESHOLDS) {
      // spent >= limit * num / den, without division.
      if (spent.units * t.den < limit.units * t.num) continue
      if (this.state.file.fired(budget.id, start).includes(t.value)) continue
      // Persist first: if emitting fails or the process dies, the alert is never repeated.
      this.state.file.markFired(budget.id, start, t.value)
      this.announce({
        budgetId: budget.id,
        threshold: t.value,
        spent: { amount: formatFixed(spent), currency: budget.limit.currency },
        limit: { ...budget.limit },
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
