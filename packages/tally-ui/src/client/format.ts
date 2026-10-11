/** Pure formatting helpers of dsh-tally-ui. Money is a decimal string and is only ever handled as a string or a BigInt. */
import type { Money, TallyTokens } from 'dsh-tally-api'

export type Locale = 'zh' | 'en'

const SYMBOLS: Record<string, string> = { CNY: '¥', USD: '$' }
const CURRENCY_ORDER = ['CNY', 'USD']
/** Longest fraction shown. */
const DECIMALS = 4

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Formats one amount: thousands grouping, at most four decimals (half-up on the magnitude, trailing
 * zeros dropped), `<¥0.0001` for a positive value below the precision, a leading `-` for a negative one.
 * The locale does not change the output: symbols follow the currency.
 */
export function formatMoney(m: Money, _locale: Locale): string {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(m.amount.trim())
  const symbol = SYMBOLS[m.currency] ?? `${m.currency} `
  if (!match || (match[2] === '' && !match[3])) return `${symbol}${m.amount}`
  const negative = match[1] === '-'
  const whole = (match[2] ?? '').replace(/^0+(?=\d)/, '') || '0'
  const fraction = match[3] ?? ''
  const sign = negative ? '-' : ''
  if (/^0*$/.test(whole === '0' ? '' : whole) && /^0*$/.test(fraction)) return `${symbol}0`
  const kept = fraction.slice(0, DECIMALS).padEnd(DECIMALS, '0')
  if (whole === '0' && kept === '0'.repeat(DECIMALS)) return negative ? `>-${symbol}0.0001` : `<${symbol}0.0001`
  let scaled = BigInt(whole + kept)
  if ((fraction[DECIMALS] ?? '0') >= '5') scaled += 1n
  const digits = scaled.toString().padStart(DECIMALS + 1, '0')
  const intPart = digits.slice(0, -DECIMALS)
  const fracPart = digits.slice(-DECIMALS).replace(/0+$/, '')
  return `${sign}${symbol}${group(intPart)}${fracPart === '' ? '' : `.${fracPart}`}`
}

/** Joins amounts of several currencies with ` + ` (CNY first, then USD); an empty list is `—`. */
export function formatMoneyList(list: readonly Money[], locale: Locale): string {
  if (list.length === 0) return '—'
  const rank = (currency: string) => {
    const i = CURRENCY_ORDER.indexOf(currency)
    return i === -1 ? CURRENCY_ORDER.length : i
  }
  return [...list].sort((a, b) => rank(a.currency) - rank(b.currency)).map(m => formatMoney(m, locale)).join(' + ')
}

/** Abbreviates a token count with `k` and `M`, one decimal. */
export function formatTokens(n: number, _locale: Locale): string {
  const abs = Math.abs(n)
  if (abs < 1000) return String(n)
  const tenths = (value: number) => Math.round(value * 10) / 10
  const k = tenths(n / 1000)
  if (Math.abs(k) < 1000) return `${k.toFixed(1)}k`
  return `${tenths(n / 1_000_000).toFixed(1)}M`
}

/** Share of the input that came from the cache; `null` when there was no input. */
export function hitRate(t: TallyTokens): number | null {
  const denominator = t.input + t.cacheRead
  return denominator === 0 ? null : t.cacheRead / denominator
}

/** `h:mm:ss` of a remaining duration in milliseconds; negative values count as zero. */
export function formatCountdown(ms: number, _locale: Locale): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${h}:${mm}:${ss}`
}
