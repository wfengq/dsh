import type { BillParseResult } from './bill.js'
import type { ReconcileReport, ReconcileRow } from './compare.js'

const HINTS: Record<string, string> = {
  unpriced: '未定价请求',
  unknownUsage: '用量未知请求',
  holidayCalendarMissing: '节假日日历缺失的高峰请求',
}

function hintText(hint: string): string {
  if (hint === 'missingInBill') return '账单中没有这一行'
  if (hint === 'missingInLedger') return '账本中没有可比的金额'
  const [name, count] = hint.split(':')
  return `${HINTS[name!] ?? name} ${count} 次`
}

function percent(ratio: string | null): string {
  if (ratio === null) return '—'
  const [whole = '0', frac = ''] = ratio.split('.')
  const micro = BigInt(whole + frac.padEnd(6, '0'))
  const hundredths = (micro + 50n) / 100n // ratio × 10000, i.e. percent with two decimals
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}%`
}

function line(r: ReconcileRow): string {
  const hints = r.hints.length > 0 ? `（${r.hints.map(hintText).join('；')}）` : ''
  // A line on one side only is a 100% difference (the ratio itself is undefined without a bill amount).
  const ratio = r.diffRatio ?? (r.ours !== null && r.bill === null ? '1' : null)
  return `  ${r.day}  ${r.model}  ${r.currency ?? '—'}  账本 ${r.ours ?? '—'}  账单 ${r.bill ?? '—'}  差额 ${r.diff}  差异 ${percent(ratio)}${hints}`
}

/**
 * Human-readable report: the headline (which also counts unparsed bill lines), the lines out of
 * tolerance, the totals with the requests the ledger could not price, then the skipped bill lines.
 */
export function formatReport(
  r: ReconcileReport,
  skipped: BillParseResult['skipped'] = [],
  routes: Record<string, string> = {},
): string {
  const out: string[] = []
  const bad = r.rows.filter(x => !x.withinTolerance)
  const head = bad.length === 0
    ? `全部 ${r.rows.length} 行都在容差（${percent(r.tolerance)}）以内`
    : `超出容差（${percent(r.tolerance)}）的行：${bad.length} / ${r.rows.length}`
  out.push(skipped.length > 0 ? `${head}；账单中另有 ${skipped.length} 行无法解析，未参与对账。` : `${head}。`)
  for (const x of bad) out.push(line(x))
  out.push('', '汇总：')
  for (const t of r.totals) {
    out.push(`  ${t.currency}  账本 ${t.ours}  账单 ${t.bill}  差额 ${t.diff}  超出容差 ${t.outOfTolerance} 行`)
  }
  const { unpricedCount, unknownUsageCount } = r.unexplained
  if (unpricedCount + unknownUsageCount > 0) {
    out.push(`  账本中未计入金额的请求：未定价 ${unpricedCount} 次，用量未知 ${unknownUsageCount} 次`)
  }
  const mapping = Object.entries(routes).map(([route, provider]) => `${route} → ${provider}`).join('，')
  if (mapping !== '') out.push(`  路由映射：${mapping}`)
  if (skipped.length > 0) {
    out.push('', `账单中有 ${skipped.length} 行无法解析，未参与对账：`)
    for (const s of skipped) out.push(`  第 ${s.line} 行：${s.reason}`)
  }
  out.push('', '估算值，以账单为准。')
  return out.join('\n') + '\n'
}
