/** Exact decimal-string arithmetic for money; nothing here touches floats. */

function parts(amount: string): { negative: boolean; digits: string; scale: number } {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(amount.trim())
  if (!match || ((match[2] ?? '') === '' && !match[3])) return { negative: false, digits: '0', scale: 0 }
  const fraction = match[3] ?? ''
  return { negative: match[1] === '-', digits: `${match[2] ?? ''}${fraction}` || '0', scale: fraction.length }
}

function scaled(amount: string, scale: number): bigint {
  const p = parts(amount)
  const value = BigInt(p.digits) * 10n ** BigInt(scale - p.scale)
  return p.negative ? -value : value
}

/** Sum of two decimal strings, without trailing fraction zeros. */
export function addDecimal(a: string, b: string): string {
  const scale = Math.max(parts(a).scale, parts(b).scale)
  const sum = scaled(a, scale) + scaled(b, scale)
  const negative = sum < 0n
  const digits = (negative ? -sum : sum).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`
}

/** Negative, zero or positive as `a` is below, equal to or above `b`. */
export function compareDecimal(a: string, b: string): number {
  const scale = Math.max(parts(a).scale, parts(b).scale)
  const x = scaled(a, scale)
  const y = scaled(b, scale)
  return x < y ? -1 : x > y ? 1 : 0
}
