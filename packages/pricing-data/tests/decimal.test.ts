import { describe, expect, it } from 'vitest'
import { addFixed, costOf, formatFixed, parseAmount, parseDecimal } from '../src/decimal.js'

describe('fixed-point decimal', () => {
  it('computes exact costs per million tokens', () => {
    expect(formatFixed(costOf(1_000_000, parseDecimal('2')))).toBe('2')
    expect(formatFixed(costOf(1234, parseDecimal('2')))).toBe('0.002468')
    expect(formatFixed(costOf(5678, parseDecimal('0.04')))).toBe('0.00022712')
  })

  it('adds fixed values exactly', () => {
    expect(formatFixed(addFixed(addFixed(costOf(1234, parseDecimal('2')), costOf(5678, parseDecimal('0.04'))), costOf(910, parseDecimal('8'))))).toBe('0.00997512')
  })

  it('formats zero as "0" and never uses scientific notation', () => {
    expect(formatFixed(costOf(0, parseDecimal('27.0')))).toBe('0')
    expect(formatFixed(costOf(1, parseDecimal('0.000000000001')))).toBe('0.000000000000000001')
  })

  it('rejects invalid input with RangeError', () => {
    expect(() => parseDecimal('-1')).toThrow(RangeError)
    expect(() => parseDecimal('1e3')).toThrow(RangeError)
    expect(() => parseDecimal('0.0000000000001')).toThrow(RangeError) // 13 decimal places
  })

  it('parses amounts up to 18 decimal places and round-trips with formatFixed', () => {
    expect(parseAmount('0.000000000000000001').units).toBe(1n)
    expect(formatFixed(parseAmount('12.123456789012345678'))).toBe('12.123456789012345678')
    expect(parseAmount('2')).toEqual(parseDecimal('2'))
    expect(() => parseAmount('0.0000000000000000001')).toThrow(RangeError) // 19 decimal places
    expect(() => parseAmount('-1')).toThrow(RangeError)
    expect(() => parseAmount('1e3')).toThrow(RangeError)
  })
})
