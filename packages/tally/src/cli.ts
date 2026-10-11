#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Currency } from 'dsh-tally-api'
import { pickBillParser, type BillColumn } from './reconcile/bill.js'
import './reconcile/generic-csv.js'
import type { ProviderPriceOverride } from 'dsh-tally-api'
import { compare } from './reconcile/compare.js'
import { ledgerDaily } from './reconcile/ledger.js'
import { formatReport } from './reconcile/report.js'

const USAGE = `用法：dsh-tally reconcile --bill <账单文件> [选项]

把账本中按天、按模型的费用和厂商账单逐行对比。

选项：
  --bill <文件>          账单导出文件（必填）
  --format <格式>        账单格式；目前可用：csv
  --from <YYYY-MM-DD>    起始日期（含），默认取账单中最早的日期
  --to <YYYY-MM-DD>      结束日期（含），默认取账单中最晚的日期
  --tz <时区>            划分日期的时区，默认 Asia/Shanghai
  --db <路径>            账本数据库，默认 $DSH_HOME/tally/tally.v1.sqlite
  --currency <币种>      账单没有币种列时使用的币种（CNY 或 USD）
  --column <列=列名>     指定列名，可重复：day、model、amount、currency
  --model-map <a=b>      把账单中的模型名 a 当作 b，可重复
  --route <路由=厂商>    追加路由映射（默认已含 deepseek-official、deepseek-account → deepseek），可重复
  --overrides <文件>     价格覆盖配置（JSON 数组，格式与插件的 overrides 配置相同）
  --tolerance <比例>     容差，默认 0.01（即 1%）
  --json                 输出 JSON
  --help                 显示本帮助

退出码：0 全部在容差内；1 有超出容差的行，或账单中有无法解析的行；2 参数或文件错误。
`

class UsageError extends Error {}

/** The plugin's default route mapping (see `Config.providerRoutes` in ./index.ts). */
const DEFAULT_ROUTES: Record<string, string> = { 'deepseek-official': 'deepseek', 'deepseek-account': 'deepseek' }

function pairs(list: string[] | undefined, what: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of list ?? []) {
    const i = item.indexOf('=')
    if (i <= 0 || i === item.length - 1) throw new UsageError(`${what} 的格式应为 a=b：${item}`)
    out[item.slice(0, i)] = item.slice(i + 1)
  }
  return out
}

function main(argv: string[]): number {
  const [command, ...rest] = argv
  if (command !== 'reconcile') {
    process.stdout.write(USAGE)
    return command === undefined || command === '--help' ? 0 : 2
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      bill: { type: 'string' }, format: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
      tz: { type: 'string', default: 'Asia/Shanghai' }, db: { type: 'string' }, currency: { type: 'string' },
      column: { type: 'string', multiple: true }, 'model-map': { type: 'string', multiple: true },
      route: { type: 'string', multiple: true }, overrides: { type: 'string' },
      tolerance: { type: 'string', default: '0.01' }, json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (values.bill === undefined) throw new UsageError('缺少 --bill')
  if (values.currency !== undefined && values.currency !== 'CNY' && values.currency !== 'USD') {
    throw new UsageError(`不支持的币种：${values.currency}`)
  }
  if (!/^\d+(\.\d+)?$/.test(values.tolerance!)) throw new UsageError(`容差应为非负小数：${values.tolerance}`)
  for (const d of [values.from, values.to]) {
    if (d !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new UsageError(`日期格式应为 YYYY-MM-DD：${d}`)
  }
  const columns = pairs(values.column, '--column') as Partial<Record<BillColumn, string>>
  for (const k of Object.keys(columns)) {
    if (!['day', 'model', 'amount', 'currency'].includes(k)) throw new UsageError(`未知的列：${k}`)
  }

  let text: string
  try {
    text = readFileSync(values.bill, 'utf8')
  } catch {
    throw new UsageError(`无法读取账单文件：${values.bill}`)
  }
  const parser = pickBillParser(text, values.format)
  const parsed = parser.parse(text, {
    columns, currency: values.currency as Currency | undefined, modelMap: pairs(values['model-map'], '--model-map'),
  })
  const days = parsed.rows.map(r => r.day).sort()
  const from = values.from ?? days[0]
  const to = values.to ?? days.at(-1)
  if (from === undefined || to === undefined) {
    const reasons = parsed.skipped.map(s => `  第 ${s.line} 行：${s.reason}`).join('\n')
    throw new UsageError(reasons === '' ? '账单中没有可对账的行' : `账单中没有可对账的行：\n${reasons}`)
  }
  const routes = { ...DEFAULT_ROUTES, ...pairs(values.route, '--route') }
  let overrides: ProviderPriceOverride[] = []
  if (values.overrides !== undefined) {
    try {
      overrides = JSON.parse(readFileSync(values.overrides, 'utf8')) as ProviderPriceOverride[]
    } catch {
      throw new UsageError(`无法读取价格覆盖文件：${values.overrides}`)
    }
    if (!Array.isArray(overrides)) throw new UsageError(`价格覆盖文件应为 JSON 数组：${values.overrides}`)
  }
  const bill = parsed.rows.filter(r => r.day >= from && r.day <= to)
  const ledger = ledgerDaily({
    dbPath: values.db ?? dshHomePath('tally', 'tally.v1.sqlite'), from, to, tz: values.tz!, providerRoutes: routes, overrides,
  })
  const report = compare(ledger, bill, values.tolerance)
  process.stdout.write(values.json
    ? JSON.stringify({ ...report, skipped: parsed.skipped, routes }, null, 2) + '\n'
    : formatReport(report, parsed.skipped, routes))
  return report.rows.every(r => r.withinTolerance) && parsed.skipped.length === 0 ? 0 : 1
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`dsh-tally: ${error instanceof Error ? error.message : String(error)}\n`)
  if (!(error instanceof UsageError)) process.stderr.write('使用 dsh-tally reconcile --help 查看用法。\n')
  process.exitCode = 2
}
