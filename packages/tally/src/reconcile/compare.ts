import type { Currency } from 'dsh-tally-api'
import type { BillRow } from './bill.js'
import { formatUnits, unitsOf } from './decimal.js'
import type { LedgerDay } from './ledger.js'

export interface ReconcileRow {
  day: string
  model: string
  currency: Currency
  ours: string | null
  bill: string | null
  /** `ours − bill`, a missing side counting as 0. */
  diff: string
  /** `|diff| / bill`, rounded half-up to 6 decimals; `null` when the bill side is 0 or missing. */
  diffRatio: string | null
  withinTolerance: boolean
  hints: string[]
}

export interface ReconcileTotal {
  currency: Currency
  ours: string
  bill: string
  diff: string
  outOfTolerance: number
}

export interface ReconcileReport {
  tolerance: string
  rows: ReconcileRow[]
  totals: ReconcileTotal[]
}

const MICRO = 1_000_000n
const SCALE = 10n ** 18n

/** `|diff| / bill` in millionths, rounded half-up. */
function ratioMicro(diff: bigint, bill: bigint): bigint {
  const abs = diff < 0n ? -diff : diff
  return (2n * abs * MICRO + bill) / (2n * bill)
}

function formatMicro(micro: bigint): string {
  return formatUnits(micro * (SCALE / MICRO))
}

/** Join the ledger and the bill on (day, model, currency) and grade each line against `tolerance`. */
export function compare(ledger: LedgerDay[], bill: BillRow[], tolerance = '0.01'): ReconcileReport {
  const toleranceMicro = unitsOf(tolerance) / (SCALE / MICRO)
  const key = (day: string, model: string, currency: Currency) => `${day}\u0000${model}\u0000${currency}`
  const billSums = new Map<string, { day: string; model: string; currency: Currency; units: bigint }>()
  for (const b of bill) {
    const k = key(b.day, b.model, b.currency)
    const sum = billSums.get(k)
    if (sum) sum.units += unitsOf(b.amount)
    else billSums.set(k, { day: b.day, model: b.model, currency: b.currency, units: unitsOf(b.amount) })
  }
  // Lines that priced nothing carry no money; their counts still reach `hintsFor`.
  const ours = new Map<string, LedgerDay>()
  for (const l of ledger) if (l.currency !== null) ours.set(key(l.day, l.model, l.currency), l)
  const hintsFor = (day: string, model: string): string[] => {
    const lines = ledger.filter(l => l.day === day && l.model === model)
    const sum = (f: (l: LedgerDay) => number) => lines.reduce((n, l) => n + f(l), 0)
    const hints: string[] = []
    if (sum(l => l.unpricedCount) > 0) hints.push(`unpriced:${sum(l => l.unpricedCount)}`)
    if (sum(l => l.unknownUsageCount) > 0) hints.push(`unknownUsage:${sum(l => l.unknownUsageCount)}`)
    if (sum(l => l.holidayMissingCount) > 0) hints.push(`holidayCalendarMissing:${sum(l => l.holidayMissingCount)}`)
    return hints
  }

  const rows: ReconcileRow[] = []
  const keys = new Set([...ours.keys(), ...billSums.keys()])
  for (const k of [...keys].sort()) {
    const l = ours.get(k)
    const b = billSums.get(k)
    const [day, model, currency] = k.split('\u0000') as [string, string, Currency]
    const oursUnits = l ? unitsOf(l.amount) : 0n
    const billUnits = b ? b.units : 0n
    const diff = oursUnits - billUnits
    const ratio = b && billUnits > 0n ? ratioMicro(diff, billUnits) : null
    const hints = hintsFor(day, model)
    if (!b) hints.push('missingInBill')
    if (!l) hints.push('missingInLedger')
    rows.push({
      day, model, currency,
      ours: l ? l.amount : null,
      bill: b ? formatUnits(billUnits) : null,
      diff: formatUnits(diff),
      diffRatio: ratio === null ? null : formatMicro(ratio),
      withinTolerance: !!l && !!b && (ratio === null ? diff === 0n : ratio <= toleranceMicro),
      hints,
    })
  }
  const totals = new Map<Currency, { ours: bigint; bill: bigint; out: number }>()
  for (const r of rows) {
    let t = totals.get(r.currency)
    if (!t) totals.set(r.currency, t = { ours: 0n, bill: 0n, out: 0 })
    t.ours += r.ours === null ? 0n : unitsOf(r.ours)
    t.bill += r.bill === null ? 0n : unitsOf(r.bill)
    if (!r.withinTolerance) t.out++
  }
  return {
    tolerance,
    rows,
    totals: [...totals].sort(([a], [b]) => (a < b ? -1 : 1)).map(([currency, t]) => ({
      currency, ours: formatUnits(t.ours), bill: formatUnits(t.bill), diff: formatUnits(t.ours - t.bill), outOfTolerance: t.out,
    })),
  }
}
