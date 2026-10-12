/** Loads and folds everything the dashboard shows from the `tally` Remote namespace. */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TallyRemoteApi } from 'dsh-tally/remote'
import type { Money, PeakSavings, TallyBand, TallyTokens, UsageGroup } from 'dsh-tally-api'
import { addDecimal, compareDecimal } from './decimal.ts'
import { dayKeys, type DateRange } from './definition.ts'
import type { DayAmounts } from './chart.ts'
import { hitRate } from '../format.ts'

/** The part of `ctx.remote.tally` the dashboard uses. */
export type DashboardRemote = Pick<TallyRemoteApi, 'query' | 'peakSavings' | 'exportCsv'>

const CURRENCIES = ['CNY', 'USD'] as const

export interface CurrencyChart {
  currency: Money['currency']
  days: DayAmounts[]
  /** Decimal sum of every day's peak and off-peak amount: the priced spend of the range. */
  total: string
}

export interface DashboardData {
  charts: CurrencyChart[]
  /** Cache hit rate per day, `null` for a day without input. */
  hitRates: { key: string; rate: number | null }[]
  unpricedCount: number
  /** Requests in the range, priced or not. */
  requestCount: number
  /** Every group of each ranking, largest cost first; the page shows the top 10 until asked for all. */
  models: UsageGroup[]
  workspaces: UsageGroup[]
  sessions: UsageGroup[]
  savings: PeakSavings | null
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error('tally request refused')
  return result.value
}

function amountOf(cost: readonly Money[], currency: string): string {
  return cost.find(m => m.currency === currency)?.amount ?? '0'
}

/** Orders groups by cost, largest first: CNY, then USD, then request count for groups without a price. */
function byCostDescending(a: UsageGroup, b: UsageGroup): number {
  for (const currency of CURRENCIES) {
    const order = compareDecimal(amountOf(b.cost, currency), amountOf(a.cost, currency))
    if (order !== 0) return order
  }
  return b.requestCount - a.requestCount
}

export function sortGroups(groups: readonly UsageGroup[]): UsageGroup[] {
  return [...groups].sort(byCostDescending)
}

function costByDay(groups: readonly UsageGroup[]): Map<string, readonly Money[]> {
  return new Map(groups.map(g => [g.key, g.cost]))
}

/**
 * One load of the dashboard. Per-day cost is queried per price band (flat joins off-peak); tokens and
 * unpriced counts come from an unfiltered query because unpriced requests carry no band.
 */
export async function loadDashboard(remote: DashboardRemote, range: DateRange, tz: string): Promise<DashboardData> {
  const base = { from: range.from, to: range.to, tz }
  const day = (band?: TallyBand) => remote.query({ ...base, groupBy: 'day', ...band === undefined ? {} : { filter: { band } } }).then(unwrap)
  const by = (groupBy: 'model' | 'workspace' | 'session') => remote.query({ ...base, groupBy }).then(unwrap)
  const [all, peak, offpeak, flat, models, workspaces, sessions, savings] = await Promise.all([
    day(), day('peak'), day('offpeak'), day('flat'), by('model'), by('workspace'), by('session'),
    remote.peakSavings({ from: range.from, to: range.to }).then(unwrap),
  ])
  const keys = dayKeys(range)
  const peakBy = costByDay(peak)
  const offpeakBy = costByDay(offpeak)
  const flatBy = costByDay(flat)
  const currencies = CURRENCIES.filter(c => [peak, offpeak, flat].some(groups => groups.some(g => g.cost.some(m => m.currency === c))))
  const charts = currencies.map((currency): CurrencyChart => {
    const days = keys.map(key => ({
      key,
      peak: amountOf(peakBy.get(key) ?? [], currency),
      offpeak: addDecimal(amountOf(offpeakBy.get(key) ?? [], currency), amountOf(flatBy.get(key) ?? [], currency)),
    }))
    const total = days.reduce((sum, day) => addDecimal(addDecimal(sum, day.peak), day.offpeak), '0')
    return { currency, days, total }
  })
  const tokensBy = new Map<string, TallyTokens>(all.map(g => [g.key, g.tokens]))
  const hitRates = keys.map(key => {
    const tokens = tokensBy.get(key)
    return { key, rate: tokens === undefined ? null : hitRate(tokens) }
  })
  return {
    charts,
    hitRates,
    unpricedCount: all.reduce((sum, g) => sum + g.unpricedCount, 0),
    requestCount: all.reduce((sum, g) => sum + g.requestCount, 0),
    models: sortGroups(models),
    workspaces: sortGroups(workspaces),
    sessions: sortGroups(sessions),
    savings,
  }
}
