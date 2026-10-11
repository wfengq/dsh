import { formatFixed, parseAmount } from 'dsh-pricing-data'
import type { Currency } from 'dsh-tally-api'
import { registerBillParser, type BillColumn, type BillParser, type BillParseResult } from './bill.js'
import { parseCsv } from './csv-read.js'

const ALIASES: Record<BillColumn, string[]> = {
  day: ['日期', 'date', 'day', '账单日期'],
  model: ['模型', 'model'],
  amount: ['金额', '费用', 'amount', 'cost'],
  currency: ['币种', 'currency'],
}
const LABELS: Record<BillColumn, string> = { day: '日期', model: '模型', amount: '金额', currency: '币种' }

function isCurrency(s: string): s is Currency {
  return s === 'CNY' || s === 'USD'
}

/** `YYYY-MM-DD`, `YYYY/MM/DD` and either followed by a time → `YYYY-MM-DD`, or null. */
function parseDay(raw: string): string | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(raw.trim())
  if (!m) return null
  const [, y, mo, d] = m
  const day = `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`
  const t = new Date(day + 'T00:00:00Z')
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== day ? null : day
}

/** Strip currency symbols, thousands separators and blanks, then normalize; null if not a decimal. */
function parseMoney(raw: string): string | null {
  const cleaned = raw.replace(/[¥￥$,\s]/g, '')
  try {
    return formatFixed(parseAmount(cleaned))
  } catch {
    return null
  }
}

export const genericCsv: BillParser = {
  id: 'csv',
  describe: '通用 CSV：按列名识别日期、模型、金额、币种，可用 --column 指定列名',
  detect: () => false,
  parse(text, options): BillParseResult {
    const [header = [], ...body] = parseCsv(text)
    const names = header.map(h => h.trim().toLowerCase())
    const index = (col: BillColumn): number => {
      const wanted = options.columns?.[col]
      const candidates = wanted !== undefined ? [wanted.trim().toLowerCase()] : ALIASES[col]
      return names.findIndex(n => candidates.includes(n))
    }
    const at = { day: index('day'), model: index('model'), amount: index('amount'), currency: index('currency') }
    for (const col of ['day', 'model', 'amount'] as const) {
      if (at[col] < 0) throw new Error(`账单缺少“${LABELS[col]}”列（可用 --column ${col}=<列名> 指定）`)
    }
    if (at.currency < 0 && options.currency === undefined) {
      throw new Error('账单没有“币种”列，请用 --currency 指定币种')
    }
    const result: BillParseResult = { rows: [], skipped: [] }
    body.forEach((fields, i) => {
      const line = i + 2
      const day = parseDay(fields[at.day] ?? '')
      if (day === null) return void result.skipped.push({ line, reason: `无法解析日期：${fields[at.day] ?? ''}` })
      const amount = parseMoney(fields[at.amount] ?? '')
      if (amount === null) return void result.skipped.push({ line, reason: `无法解析金额：${fields[at.amount] ?? ''}` })
      const currency = at.currency >= 0 ? (fields[at.currency] ?? '').trim().toUpperCase() : options.currency!
      if (!isCurrency(currency)) return void result.skipped.push({ line, reason: `不支持的币种：${currency}` })
      const rawModel = (fields[at.model] ?? '').trim()
      if (rawModel === '') return void result.skipped.push({ line, reason: '模型为空' })
      const model = options.modelMap?.[rawModel] ?? rawModel
      result.rows.push({ day, model, amount, currency, line })
    })
    return result
  },
}

registerBillParser(genericCsv)
