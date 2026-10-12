import type { Wallet } from 'dsh-tally-api'

type Currency = Wallet['money']['currency']

// Same notation accepted by the official account platform.
const DECIMAL_RE = /^(-?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i

// Guards against exponents that would make us allocate absurdly long strings.
const MAX_EXPONENT = 1000

/**
 * Normalizes a decimal string: no exponent, no redundant leading or trailing zeros,
 * zero is always `"0"` (never `"-0"`). Throws `RangeError` for invalid input.
 * Uses string operations only.
 */
export function normalizeDecimal(s: string): string {
  const m = typeof s === 'string' ? DECIMAL_RE.exec(s) : null
  if (!m) throw new RangeError(`Invalid decimal: ${JSON.stringify(s)}`)
  const negative = m[1] === '-'
  const intPart = m[2] ?? ''
  const fracPart = m[3] ?? m[4] ?? ''
  const exponent = m[5] === undefined ? 0 : Number(m[5])
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_EXPONENT) {
    throw new RangeError(`Decimal exponent out of range: ${JSON.stringify(s)}`)
  }

  // value = 0.<digits> * 10^pointPos, with `digits` stripped of leading zeros
  let digits = intPart + fracPart
  let pointPos = intPart.length + exponent
  const leading = digits.length - digits.replace(/^0+/, '').length
  digits = digits.slice(leading)
  pointPos -= leading
  digits = digits.replace(/0+$/, '')
  if (digits === '') return '0'

  let body: string
  if (pointPos <= 0) body = `0.${'0'.repeat(-pointPos)}${digits}`
  else if (pointPos >= digits.length) body = digits + '0'.repeat(pointPos - digits.length)
  else body = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`
  return negative ? `-${body}` : body
}

/** Splits a normalized decimal into a scaled BigInt (value * 10^scale). */
function toScaled(normalized: string, scale: number): bigint {
  const negative = normalized.startsWith('-')
  const abs = negative ? normalized.slice(1) : normalized
  const [int, frac = ''] = abs.split('.')
  const scaled = BigInt(int + frac.padEnd(scale, '0'))
  return negative ? -scaled : scaled
}

function fractionLength(normalized: string): number {
  const dot = normalized.indexOf('.')
  return dot === -1 ? 0 : normalized.length - dot - 1
}

/** Exact decimal addition (negatives allowed). The result is normalized. */
export function addDecimals(a: string, b: string): string {
  const na = normalizeDecimal(a)
  const nb = normalizeDecimal(b)
  const scale = Math.max(fractionLength(na), fractionLength(nb))
  const sum = toScaled(na, scale) + toScaled(nb, scale)
  const negative = sum < 0n
  const digits = (negative ? -sum : sum).toString().padStart(scale + 1, '0')
  const body = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
  return normalizeDecimal(negative ? `-${body}` : body)
}

const SHAPE_ERROR = 'DeepSeek balance: unexpected response shape'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isSupportedCurrency(c: unknown): c is Currency {
  return c === 'CNY' || c === 'USD'
}

function apiAmount(v: unknown): string {
  if (typeof v !== 'string') throw new Error(SHAPE_ERROR)
  try {
    return normalizeDecimal(v)
  } catch {
    throw new Error(SHAPE_ERROR)
  }
}

function walletTriple(currency: Currency, topup: string, granted: string, total: string): Wallet[] {
  return [
    { kind: 'topup', money: { amount: topup, currency } },
    { kind: 'granted', money: { amount: granted, currency } },
    { kind: 'total', money: { amount: total, currency } },
  ]
}

/**
 * Parses the response of `GET /user/balance`:
 * `{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }`.
 * Entries in currencies other than CNY or USD are skipped.
 */
export function parseApiBalance(json: unknown): Wallet[] {
  if (!isRecord(json) || !Array.isArray(json.balance_infos)) throw new Error(SHAPE_ERROR)
  const wallets: Wallet[] = []
  for (const info of json.balance_infos as unknown[]) {
    if (!isRecord(info)) throw new Error(SHAPE_ERROR)
    if (!isSupportedCurrency(info.currency)) continue
    wallets.push(
      ...walletTriple(
        info.currency,
        apiAmount(info.topped_up_balance),
        apiAmount(info.granted_balance),
        apiAmount(info.total_balance),
      ),
    )
  }
  return wallets
}

export interface AccountBalanceEntry {
  currency: Currency
  balance: string
}

export interface AccountBalanceInput {
  value: readonly AccountBalanceEntry[]
  bonusWallets: readonly AccountBalanceEntry[]
}

/**
 * Converts the official account platform balance: `value` entries sum to `topup`,
 * `bonusWallets` entries sum to `granted`, and `total` is their sum. Output is grouped by
 * currency (in order of first appearance), each as topup, granted, total.
 */
export function parseAccountBalance(r: AccountBalanceInput): Wallet[] {
  const totals = new Map<Currency, { topup: string; granted: string }>()
  const bucket = (currency: Currency) => {
    let entry = totals.get(currency)
    if (!entry) totals.set(currency, (entry = { topup: '0', granted: '0' }))
    return entry
  }
  for (const item of r.value) {
    const entry = bucket(item.currency)
    entry.topup = addDecimals(entry.topup, item.balance)
  }
  for (const item of r.bonusWallets) {
    const entry = bucket(item.currency)
    entry.granted = addDecimals(entry.granted, item.balance)
  }
  const wallets: Wallet[] = []
  for (const [currency, { topup, granted }] of totals) {
    wallets.push(...walletTriple(currency, topup, granted, addDecimals(topup, granted)))
  }
  return wallets
}
