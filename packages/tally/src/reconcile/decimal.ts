import { formatFixed, parseAmount } from 'dsh-pricing-data'

/** Signed decimal string → 18-decimal fixed-point units. */
export function unitsOf(s: string): bigint {
  return s.startsWith('-') ? -parseAmount(s.slice(1)).units : parseAmount(s).units
}

/** Fixed-point units → normalized signed decimal string. */
export function formatUnits(units: bigint): string {
  return units < 0n ? '-' + formatFixed({ units: -units }) : formatFixed({ units })
}
