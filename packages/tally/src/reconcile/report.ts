import type { BillParseResult } from './bill.js'
import type { ReconcileReport, ReconcileRow } from './compare.js'
import type { DeepSeekDaily, DeepSeekTotal } from './deepseek.js'

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
  /** Extra sections (such as the DeepSeek wallet split), printed before the closing disclaimer. */
  extra = '',
): string {
  const out: string[] = []
  const compared = r.rows.filter(x => x.compared)
  const early = r.rows.filter(x => !x.compared)
  const bad = compared.filter(x => !x.withinTolerance)
  const head = bad.length === 0
    ? `全部 ${compared.length} 行都在容差（${percent(r.tolerance)}）以内`
    : `超出容差（${percent(r.tolerance)}）的行：${bad.length} / ${compared.length}`
  out.push(skipped.length > 0 ? `${head}；账单中另有 ${skipped.length} 行无法解析，未参与对账。` : `${head}。`)
  for (const x of bad) out.push(line(x))
  if (early.length > 0) {
    out.push('', `价格数据开始之前的 ${early.length} 行不参与比较（账本没有那时的价格）：`)
    for (const x of early) {
      const start = x.hints.find(h => h.startsWith('beforePrices:'))?.slice('beforePrices:'.length)
      out.push(`  ${x.day}  ${x.model}  ${x.currency ?? '—'}  账单 ${x.bill ?? '—'}（价格数据从 ${start} 开始）`)
    }
  }
  out.push('', '汇总：')
  for (const t of r.totals) {
    const skippedBill = t.notCompared !== '0' ? `（另有未参与比较的账单 ${t.notCompared}）` : ''
    out.push(`  ${t.currency}  账本 ${t.ours}  账单 ${t.bill}  差额 ${t.diff}  超出容差 ${t.outOfTolerance} 行${skippedBill}`)
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
  if (extra !== '') out.push(extra.replace(/\n$/, ''))
  out.push('', '估算值，以账单为准。')
  return out.join('\n') + '\n'
}

function walletText(d: { paid: string; granted: string; total: string; requestCount: number | null }, others: string): string {
  const requests = d.requestCount === null ? '' : `  请求 ${d.requestCount} 次`
  return `Paid（充值余额）${d.paid}  Granted（赠金）${d.granted}${others}  合计 ${d.total}${requests}`
}

/**
 * The DeepSeek bill split by wallet: what came out of the top-up balance (Paid) and what out of
 * granted credit, per day and in total. The comparison above uses the total of every wallet.
 */
export function formatDeepSeekSplit(
  summary: { daily: DeepSeekDaily[]; totals: DeepSeekTotal[] },
  source: string,
  notes: readonly string[] = [],
): string {
  const out = [`DeepSeek 账单按钱包拆分（来自 ${source}）：`]
  for (const d of summary.daily) {
    const others = Object.entries(d.wallets).filter(([w]) => w !== 'Paid' && w !== 'Granted').map(([w, v]) => `  ${w} ${v}`).join('')
    out.push(`  ${d.day}  ${d.model}  ${d.currency}  ${walletText(d, others)}`)
  }
  for (const t of summary.totals) out.push(`  合计 ${t.currency}  ${walletText(t, '')}`)
  out.push('  对账比较的是各钱包之和；其中只有 Paid 是充值余额的扣费，不应把合计当作现金支出。')
  if (summary.totals.some(t => t.requestCount !== null)) out.push('  请求次数来自用量表，只作参考，不另计费。')
  for (const n of notes) out.push(`  注意：${n}`)
  return '\n' + out.join('\n') + '\n'
}
