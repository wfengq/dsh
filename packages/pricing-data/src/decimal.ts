/** Fixed-point decimal with 18 fractional digits: `units = value * 10^18`. */
export interface Fixed {
  units: bigint
}

const SCALE_DIGITS = 18
const SCALE = 10n ** BigInt(SCALE_DIGITS)
const MAX_RATE_DECIMALS = 12
const TOKENS_PER_MILLION = 1_000_000n

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/

/** Parse a non-negative decimal string with at most 12 decimal places. */
export function parseDecimal(s: string): Fixed {
  const match = typeof s === 'string' ? DECIMAL_PATTERN.exec(s) : null
  if (!match) throw new RangeError(`Invalid decimal string: ${JSON.stringify(s)}`)
  const [, whole, fraction = ''] = match
  if (fraction.length > MAX_RATE_DECIMALS) {
    throw new RangeError(`Too many decimal places (max ${MAX_RATE_DECIMALS}): ${s}`)
  }
  return { units: BigInt(whole) * SCALE + BigInt(fraction.padEnd(SCALE_DIGITS, '0')) }
}

/** Cost of `tokens` at `ratePerMillion` (per 1,000,000 tokens), exact. */
export function costOf(tokens: number, ratePerMillion: Fixed): Fixed {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new RangeError(`Invalid token count: ${tokens}`)
  }
  return { units: (BigInt(tokens) * ratePerMillion.units) / TOKENS_PER_MILLION }
}

export function addFixed(a: Fixed, b: Fixed): Fixed {
  return { units: a.units + b.units }
}

/** Plain decimal string without trailing zeros; zero is "0". */
export function formatFixed(f: Fixed): string {
  const whole = f.units / SCALE
  const fraction = (f.units % SCALE).toString().padStart(SCALE_DIGITS, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : `${whole}`
}
