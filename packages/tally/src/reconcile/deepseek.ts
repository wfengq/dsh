/**
 * DeepSeek's official bill export. One export (a ZIP) holds two CSV tables:
 *
 * - the cost table (`cost-*.csv`): one line per day, model and wallet with the amount charged. It is
 *   the only source of amounts for reconciling.
 * - the usage table (`amount-*.csv`): token and request counts per API key. Its `amount` column is a
 *   quantity, not money; it only adds request counts and a price × quantity cross-check.
 *
 * Only the layout of one synthetic sample (CNY, `Paid`/`Granted` wallets, one model) is verified.
 * Account ids and key columns are never copied into rows or reasons.
 */
import { formatFixed, parseAmount } from 'dsh-pricing-data'
import type { Currency } from 'dsh-tally-api'
import { registerBillParser, type BillParser, type BillParseResult, type BillRow } from './bill.js'
import { parseCsvRecords } from './csv-read.js'
import { formatUnits, unitsOf } from './decimal.js'
import type { ZipEntry } from './zip.js'

const COST_COLUMNS = ['start_time_iso', 'end_time_iso', 'model', 'wallet_type', 'cost', 'currency'] as const
const USAGE_COLUMNS = ['start_time_iso', 'model', 'api_key', 'type', 'price', 'amount'] as const
const TOKEN_TYPES = new Set(['input_cache_hit_tokens', 'input_cache_miss_tokens', 'output_tokens'])

export const USAGE_TABLE_MESSAGE =
  '这是 DeepSeek 用量表（amount 列是 token 和请求数量，不是金额），不能作为账单对账。'
  + '请改用同一次导出里的费用表（cost-*.csv），或直接传入官方 ZIP 导出。'

function headerOf(text: string): string[] {
  const first = parseCsvRecords(text.slice(0, 4096).split(/\r?\n/)[0] ?? '')[0]
  return (first?.fields ?? []).map(h => h.trim().toLowerCase())
}

function columnsOf<const C extends readonly string[]>(header: string[], wanted: C): Record<C[number], number> | null {
  const at = {} as Record<C[number], number>
  for (const name of wanted) {
    const i = header.indexOf(name)
    if (i < 0) return null
    at[name as C[number]] = i
  }
  return at
}

export function isDeepSeekCostTable(text: string): boolean {
  return columnsOf(headerOf(text), COST_COLUMNS) !== null
}

export function isDeepSeekUsageTable(text: string): boolean {
  return columnsOf(headerOf(text), USAGE_COLUMNS) !== null
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/

/** Epoch milliseconds of an ISO timestamp with an explicit offset; `'no-offset'` or `null` otherwise. */
function instantOf(raw: string): number | 'no-offset' | null {
  const m = ISO.exec(raw.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s = '0', zone] = m
  const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = Number(s)
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  const check = new Date(wall)
  if (hour > 23 || minute > 59 || second > 59 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null
  }
  if (zone === undefined) return 'no-offset'
  if (zone === 'Z') return wall
  const sign = zone[0] === '-' ? -1 : 1
  const [oh, om] = zone.slice(1).split(':').map(Number)
  if (oh! > 23 || om! > 59) return null
  return wall - sign * (oh! * 60 + om!) * 60_000
}

const dayFormats = new Map<string, Intl.DateTimeFormat>()

/** `YYYY-MM-DD` of an ISO timestamp with offset, in zone `tz`; `null` for an invalid or offset-less time. */
export function dayKeyOf(raw: string, tz: string): string | null {
  const at = instantOf(raw)
  if (typeof at !== 'number') return null
  let format = dayFormats.get(tz)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    dayFormats.set(tz, format)
  }
  return format.format(at)
}

function dayOrReason(raw: string, tz: string, what: string): { day: string } | { reason: string } {
  const at = instantOf(raw)
  if (at === 'no-offset') return { reason: `${what}缺少时区偏移（应为如 2000-01-01T00:00:00+08:00 的格式）：${raw}` }
  const day = at === null ? null : dayKeyOf(raw, tz)
  return day === null ? { reason: `无法解析${what}：${raw}` } : { day }
}

function decimalOrNull(raw: string): string | null {
  try {
    return formatFixed(parseAmount(raw.trim()))
  } catch {
    return null
  }
}

const DEFAULT_TZ = 'Asia/Shanghai'

export const deepseekCost: BillParser = {
  id: 'deepseek',
  describe: 'DeepSeek 官方导出的费用表（cost-*.csv），或包含它的官方 ZIP 导出',
  detect: isDeepSeekCostTable,
  parse(text, options): BillParseResult {
    const [header, ...body] = parseCsvRecords(text)
    const at = columnsOf((header?.fields ?? []).map(h => h.trim().toLowerCase()), COST_COLUMNS)
    if (at === null) throw new Error(`不是 DeepSeek 费用表：缺少列 ${COST_COLUMNS.join('、')} 中的某一列`)
    const tz = options.tz ?? DEFAULT_TZ
    const result: BillParseResult = { rows: [], skipped: [] }
    for (const { fields, line } of body) {
      const cell = (i: number) => (fields[i] ?? '').trim()
      const start = dayOrReason(cell(at.start_time_iso), tz, '开始时间')
      if ('reason' in start) { result.skipped.push({ line, reason: start.reason }); continue }
      const end = instantOf(cell(at.end_time_iso))
      if (typeof end !== 'number') { result.skipped.push({ line, reason: `无法解析结束时间：${cell(at.end_time_iso)}` }); continue }
      const rawModel = cell(at.model)
      if (rawModel === '') { result.skipped.push({ line, reason: '模型为空' }); continue }
      const wallet = cell(at.wallet_type)
      if (wallet === '') { result.skipped.push({ line, reason: '钱包类型（wallet_type）为空' }); continue }
      const amount = decimalOrNull(cell(at.cost))
      if (amount === null) { result.skipped.push({ line, reason: `无法解析金额（cost 列）：${cell(at.cost)}` }); continue }
      const currency = cell(at.currency).toUpperCase()
      if (currency !== 'CNY' && currency !== 'USD') {
        result.skipped.push({ line, reason: currency === '' ? '币种为空' : `不支持的币种：${currency}` })
        continue
      }
      const row: BillRow = { day: start.day, model: options.modelMap?.[rawModel] ?? rawModel, amount, currency, line, wallet }
      result.rows.push(row)
    }
    return result
  },
}

/** The usage table detected where a bill is expected: refused with the reason instead of read as money. */
const deepseekUsage: BillParser = {
  id: 'deepseek-usage',
  describe: 'DeepSeek 官方导出的用量表（不能单独作为账单）',
  detect: isDeepSeekUsageTable,
  parse() { throw new Error(USAGE_TABLE_MESSAGE) },
  refuse: USAGE_TABLE_MESSAGE,
}

export interface UsageDay {
  day: string
  model: string
  /** Requests of the day (sum of the `request_count` lines); never charged. */
  requests: number
  /** Σ price × amount over the token lines: a cross-check of the cost table, not a second bill. */
  computedCost: string
}

/** Request counts and the price × quantity cross-check per day and model, from the usage table. */
export function parseDeepSeekUsage(text: string, options: { tz?: string } = {}): { days: UsageDay[]; skipped: BillParseResult['skipped']; lines: number } {
  const [header, ...body] = parseCsvRecords(text)
  const at = columnsOf((header?.fields ?? []).map(h => h.trim().toLowerCase()), USAGE_COLUMNS)
  if (at === null) throw new Error(`不是 DeepSeek 用量表：缺少列 ${USAGE_COLUMNS.join('、')} 中的某一列`)
  const tz = options.tz ?? DEFAULT_TZ
  const days = new Map<string, { day: string; model: string; requests: number; units: bigint }>()
  const skipped: BillParseResult['skipped'] = []
  for (const { fields, line } of body) {
    const cell = (i: number) => (fields[i] ?? '').trim()
    const start = dayOrReason(cell(at.start_time_iso), tz, '开始时间')
    if ('reason' in start) { skipped.push({ line, reason: start.reason }); continue }
    const model = cell(at.model)
    if (model === '') { skipped.push({ line, reason: '模型为空' }); continue }
    const type = cell(at.type)
    const amount = cell(at.amount)
    if (!/^\d+$/.test(amount)) { skipped.push({ line, reason: `无法解析数量（amount 列）：${amount}` }); continue }
    const key = `${start.day}\u0000${model}`
    const entry = days.get(key) ?? { day: start.day, model, requests: 0, units: 0n }
    if (type === 'request_count') entry.requests += Number(amount)
    else if (TOKEN_TYPES.has(type)) {
      const price = decimalOrNull(cell(at.price))
      if (price === null) { skipped.push({ line, reason: `无法解析单价（price 列）：${cell(at.price)}` }); continue }
      entry.units += unitsOf(price) * BigInt(amount)
    } else { skipped.push({ line, reason: `未知的用量类型：${type}` }); continue }
    days.set(key, entry)
  }
  const list = [...days.values()].sort((a, b) => (a.day + a.model).localeCompare(b.day + b.model))
  return { days: list.map(d => ({ day: d.day, model: d.model, requests: d.requests, computedCost: formatUnits(d.units) })), skipped, lines: body.length }
}

export interface DeepSeekDaily {
  day: string
  model: string
  currency: Currency
  /** Charged to the top-up (cash) balance. */
  paid: string
  /** Charged to granted (bonus) credit. */
  granted: string
  /** Every wallet together: what the request estimates are compared against. */
  total: string
  /** Every wallet named on the bill, including ones other than Paid and Granted. */
  wallets: Record<string, string>
  /** Requests from the usage table; `null` when no usage table was given. */
  requestCount: number | null
}

export interface DeepSeekTotal {
  currency: Currency
  paid: string
  granted: string
  total: string
  requestCount: number | null
}

/** Paid, Granted and total per day, model and currency, and overall per currency. */
export function summarizeDeepSeek(cost: readonly BillRow[], usage?: readonly UsageDay[]): { daily: DeepSeekDaily[]; totals: DeepSeekTotal[] } {
  const groups = new Map<string, { day: string; model: string; currency: Currency; wallets: Map<string, bigint> }>()
  for (const r of cost) {
    const key = `${r.day}\u0000${r.model}\u0000${r.currency}`
    const g = groups.get(key) ?? { day: r.day, model: r.model, currency: r.currency, wallets: new Map() }
    const wallet = r.wallet ?? 'Unknown'
    g.wallets.set(wallet, (g.wallets.get(wallet) ?? 0n) + unitsOf(r.amount))
    groups.set(key, g)
  }
  const requests = new Map((usage ?? []).map(u => [`${u.day}\u0000${u.model}`, u.requests]))
  const daily = [...groups.values()]
    .sort((a, b) => `${a.day}\u0000${a.model}\u0000${a.currency}`.localeCompare(`${b.day}\u0000${b.model}\u0000${b.currency}`))
    .map((g): DeepSeekDaily => {
      const total = [...g.wallets.values()].reduce((a, b) => a + b, 0n)
      return {
        day: g.day, model: g.model, currency: g.currency,
        paid: formatUnits(g.wallets.get('Paid') ?? 0n),
        granted: formatUnits(g.wallets.get('Granted') ?? 0n),
        total: formatUnits(total),
        wallets: Object.fromEntries([...g.wallets].map(([k, v]) => [k, formatUnits(v)])),
        requestCount: usage === undefined ? null : requests.get(`${g.day}\u0000${g.model}`) ?? 0,
      }
    })
  const totals = new Map<Currency, { paid: bigint; granted: bigint; total: bigint; requests: number }>()
  for (const d of daily) {
    const t = totals.get(d.currency) ?? { paid: 0n, granted: 0n, total: 0n, requests: 0 }
    t.paid += unitsOf(d.paid)
    t.granted += unitsOf(d.granted)
    t.total += unitsOf(d.total)
    t.requests += d.requestCount ?? 0
    totals.set(d.currency, t)
  }
  return {
    daily,
    totals: [...totals].map(([currency, t]) => ({
      currency, paid: formatUnits(t.paid), granted: formatUnits(t.granted), total: formatUnits(t.total),
      requestCount: usage === undefined ? null : t.requests,
    })),
  }
}

/**
 * Picks the tables of an official ZIP export: exactly one cost table (the amounts), and the usage table
 * when there is exactly one (request counts). Other files are ignored.
 */
export function loadDeepSeekExport(entries: readonly ZipEntry[]): { costName: string; costText: string; usageName?: string; usageText?: string; notes: string[] } {
  const csv = entries
    .filter(e => e.name.toLowerCase().endsWith('.csv'))
    .map(e => ({ name: e.name, text: e.data.toString('utf8') }))
  const costs = csv.filter(f => isDeepSeekCostTable(f.text))
  const usages = csv.filter(f => isDeepSeekUsageTable(f.text))
  if (costs.length === 0) {
    throw new Error(`ZIP 中没有费用表（需要列 ${COST_COLUMNS.join('、')}）${usages.length > 0 ? '；用量表不能作为账单' : ''}`)
  }
  if (costs.length > 1) throw new Error(`ZIP 中有多份费用表，无法确定用哪一份：${costs.map(c => c.name).join('、')}`)
  const notes: string[] = []
  if (usages.length > 1) notes.push(`ZIP 中有 ${usages.length} 份用量表（${usages.map(u => u.name).join('、')}），请求次数未统计`)
  const usage = usages.length === 1 ? usages[0] : undefined
  return {
    costName: costs[0]!.name,
    costText: costs[0]!.text,
    ...(usage === undefined ? {} : { usageName: usage.name, usageText: usage.text }),
    notes,
  }
}

registerBillParser(deepseekCost)
registerBillParser(deepseekUsage)
