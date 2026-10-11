import { describe, expect, it } from 'vitest'
import { addDecimals, normalizeDecimal, parseAccountBalance, parseApiBalance } from '../src/parse.js'

describe('normalizeDecimal', () => {
  it.each([
    ['0E-16', '0'],
    ['1.50', '1.5'],
    ['.5', '0.5'],
    ['5.', '5'],
    ['1e3', '1000'],
    ['1.25E-2', '0.0125'],
    ['-1.50', '-1.5'],
    ['-0.0', '0'],
    ['007', '7'],
    ['100', '100'],
    ['1.5e+2', '150'],
    ['-0E5', '0'],
    ['0.000000000000000001', '0.000000000000000001'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeDecimal(input)).toBe(expected)
  })

  it.each(['abc', '', '.', '-', '1e', '1.2.3', ' 1', 'Infinity', 'NaN'])('rejects %j', (input) => {
    expect(() => normalizeDecimal(input)).toThrow(RangeError)
  })
})

describe('addDecimals', () => {
  it('handles negative results', () => {
    expect(addDecimals('1.5', '-2')).toBe('-0.5')
  })
  it('aligns differing fractional lengths', () => {
    expect(addDecimals('0.1', '0.25')).toBe('0.35')
    expect(addDecimals('100', '0.000000000000000001')).toBe('100.000000000000000001')
  })
  it('never yields negative zero', () => {
    expect(addDecimals('1.5', '-1.5')).toBe('0')
    expect(addDecimals('0', '0')).toBe('0')
  })
  it('adds two negatives', () => {
    expect(addDecimals('-1.25', '-2')).toBe('-3.25')
  })
})

describe('parseApiBalance', () => {
  it('emits topup, granted, total for a CNY entry', () => {
    const wallets = parseApiBalance({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      ],
    })
    expect(wallets).toEqual([
      { kind: 'topup', money: { amount: '100', currency: 'CNY' } },
      { kind: 'granted', money: { amount: '10', currency: 'CNY' } },
      { kind: 'total', money: { amount: '110', currency: 'CNY' } },
    ])
  })

  it('skips currencies other than CNY and USD', () => {
    const wallets = parseApiBalance({
      is_available: true,
      balance_infos: [
        { currency: 'EUR', total_balance: '1', granted_balance: '0', topped_up_balance: '1' },
        { currency: 'USD', total_balance: '2.50', granted_balance: '0', topped_up_balance: '2.50' },
      ],
    })
    expect(wallets.map((w) => w.money.currency)).toEqual(['USD', 'USD', 'USD'])
    expect(wallets[2]).toEqual({ kind: 'total', money: { amount: '2.5', currency: 'USD' } })
  })

  it('throws on a missing or non-array balance_infos', () => {
    const message = 'DeepSeek balance: unexpected response shape'
    expect(() => parseApiBalance({ is_available: true })).toThrow(message)
    expect(() => parseApiBalance({ balance_infos: 'x' })).toThrow(message)
    expect(() => parseApiBalance(null)).toThrow(message)
    expect(() => parseApiBalance('x')).toThrow(message)
  })

  it('throws on invalid or non-string amounts', () => {
    const message = 'DeepSeek balance: unexpected response shape'
    expect(() =>
      parseApiBalance({ balance_infos: [{ currency: 'CNY', total_balance: 1, granted_balance: '0', topped_up_balance: '0' }] }),
    ).toThrow(message)
    expect(() =>
      parseApiBalance({ balance_infos: [{ currency: 'CNY', total_balance: 'abc', granted_balance: '0', topped_up_balance: '0' }] }),
    ).toThrow(message)
  })
})

describe('parseAccountBalance', () => {
  it('sums value as topup and bonusWallets as granted', () => {
    const wallets = parseAccountBalance({
      value: [
        { currency: 'CNY', balance: '60' },
        { currency: 'CNY', balance: '40' },
      ],
      bonusWallets: [{ currency: 'CNY', balance: '0E-16' }],
    })
    expect(wallets).toEqual([
      { kind: 'topup', money: { amount: '100', currency: 'CNY' } },
      { kind: 'granted', money: { amount: '0', currency: 'CNY' } },
      { kind: 'total', money: { amount: '100', currency: 'CNY' } },
    ])
  })

  it('yields all three wallets for a currency present only in bonusWallets', () => {
    const wallets = parseAccountBalance({
      value: [],
      bonusWallets: [{ currency: 'USD', balance: '3.5' }],
    })
    expect(wallets).toEqual([
      { kind: 'topup', money: { amount: '0', currency: 'USD' } },
      { kind: 'granted', money: { amount: '3.5', currency: 'USD' } },
      { kind: 'total', money: { amount: '3.5', currency: 'USD' } },
    ])
  })

  it('returns [] for empty input and groups multiple currencies', () => {
    expect(parseAccountBalance({ value: [], bonusWallets: [] })).toEqual([])
    const wallets = parseAccountBalance({
      value: [
        { currency: 'CNY', balance: '1' },
        { currency: 'USD', balance: '2' },
      ],
      bonusWallets: [],
    })
    expect(wallets.map((w) => `${w.money.currency}:${w.kind}`)).toEqual([
      'CNY:topup', 'CNY:granted', 'CNY:total', 'USD:topup', 'USD:granted', 'USD:total',
    ])
  })
})
