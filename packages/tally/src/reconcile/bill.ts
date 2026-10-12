import type { Currency } from 'dsh-tally-api'

/** One bill line, normalized: a day, a model, a non-negative decimal amount and its currency. */
export interface BillRow {
  /** `YYYY-MM-DD` as printed on the bill. */
  day: string
  model: string
  /** Normalized decimal string; never a float. */
  amount: string
  currency: Currency
  /** 1-based source line (the header is line 1). */
  line: number
  /** Wallet the amount was charged to, when the bill says (DeepSeek: `Paid` or `Granted`). */
  wallet?: string
}

export interface BillParseResult {
  rows: BillRow[]
  skipped: { line: number; reason: string }[]
}

export type BillColumn = 'day' | 'model' | 'amount' | 'currency'

export interface BillParserOptions {
  columns?: Partial<Record<BillColumn, string>>
  currency?: Currency
  modelMap?: Record<string, string>
  /** IANA zone that turns bill timestamps into days; the reconcile command passes its `--tz`. */
  tz?: string
}

export interface BillParser {
  id: string
  describe: string
  detect(text: string): boolean
  parse(text: string, options: BillParserOptions): BillParseResult
  /** When set, a file this parser detects is not a bill: picking it fails with this message. */
  refuse?: string
}

const registry: BillParser[] = []

export function registerBillParser(p: BillParser): void {
  if (registry.some(q => q.id === p.id)) throw new Error(`bill parser already registered: ${p.id}`)
  registry.push(p)
}

export function billParsers(): readonly BillParser[] {
  return registry
}

/** An explicit id wins; otherwise the first parser whose `detect` accepts the text. */
export function pickBillParser(text: string, id?: string): BillParser {
  if (id !== undefined) {
    const p = registry.find(q => q.id === id)
    if (!p) throw new Error(`未知的账单格式：${id}（可用：${registry.map(q => q.id).join('、')}）`)
    return p
  }
  const hit = registry.find(q => q.detect(text))
  if (!hit) throw new Error('无法识别账单格式，请用 --format 指定')
  if (hit.refuse !== undefined) throw new Error(hit.refuse)
  return hit
}
