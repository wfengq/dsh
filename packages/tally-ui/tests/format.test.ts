import { describe, expect, it } from 'vitest'
import { formatCountdown, formatMoney, formatMoneyList, formatTokens, hitRate } from '../src/client/format.ts'

const cny = (amount: string) => ({ amount, currency: 'CNY' as const })
const usd = (amount: string) => ({ amount, currency: 'USD' as const })

describe('formatMoney', () => {
  it('groups thousands and drops trailing zeros', () => {
    expect(formatMoney(cny('123456789.5'), 'zh')).toBe('¥123,456,789.5')
    expect(formatMoney(cny('2'), 'zh')).toBe('¥2')
    expect(formatMoney(cny('2.5000'), 'en')).toBe('¥2.5')
    expect(formatMoney(usd('1000'), 'en')).toBe('$1,000')
  })
  it('rounds half-up at four decimals using strings only', () => {
    expect(formatMoney(cny('0.12345'), 'zh')).toBe('¥0.1235')
    expect(formatMoney(cny('0.12344999'), 'zh')).toBe('¥0.1234')
    expect(formatMoney(cny('9.99995'), 'zh')).toBe('¥10')
    expect(formatMoney(cny('12345678901234567890.00005'), 'zh')).toBe('¥12,345,678,901,234,567,890.0001')
  })
  it('shows a tiny positive amount as below the precision, and zero as zero', () => {
    expect(formatMoney(cny('0.000001'), 'zh')).toBe('<¥0.0001')
    expect(formatMoney(cny('0.0001'), 'zh')).toBe('¥0.0001')
    expect(formatMoney(cny('0'), 'zh')).toBe('¥0')
    expect(formatMoney(cny('0.0000'), 'zh')).toBe('¥0')
  })
  it('keeps the sign of a negative amount', () => {
    expect(formatMoney(cny('-1234.56789'), 'zh')).toBe('-¥1,234.5679')
    expect(formatMoney(usd('-0.5'), 'en')).toBe('-$0.5')
  })
})

describe('formatMoneyList', () => {
  it('orders CNY before USD and joins with +', () => {
    expect(formatMoneyList([usd('1'), cny('2')], 'zh')).toBe('¥2 + $1')
  })
  it('shows an empty list as a dash', () => {
    expect(formatMoneyList([], 'en')).toBe('—')
  })
})

describe('formatTokens', () => {
  it('abbreviates with k and M', () => {
    expect(formatTokens(1234567, 'en')).toBe('1.2M')
    expect(formatTokens(1234, 'en')).toBe('1.2k')
    expect(formatTokens(999, 'en')).toBe('999')
    expect(formatTokens(999_960, 'en')).toBe('1.0M')
  })
})

describe('hitRate', () => {
  it('is null without input', () => {
    expect(hitRate({ input: 0, cacheRead: 0, cacheWrite: 0, output: 5 })).toBeNull()
    expect(hitRate({ input: 25, cacheRead: 75, cacheWrite: 0, output: 5 })).toBe(0.75)
  })
})

describe('formatCountdown', () => {
  it('formats h:mm:ss', () => {
    expect(formatCountdown(3_723_000, 'en')).toBe('1:02:03')
    expect(formatCountdown(-5, 'en')).toBe('0:00:00')
  })
})
