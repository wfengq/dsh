import { describe, expect, it } from 'vitest'
import { bandAt, loadCatalog, quote } from '../src/index.js'
import type { PriceCatalog } from '../src/index.js'

const M = 1_000_000
const sh = (iso: string) => Date.parse(iso + '+08:00')
const c = loadCatalog()
const u = { inputTokens: M, cacheReadTokens: M, cacheWriteTokens: 0, outputTokens: M }

describe('quote', () => {
  it('prices flash at the peak rate and flags the missing holiday calendar', () => {
    expect(quote(c, { provider: 'deepseek', model: 'deepseek-flash', usage: u, at: sh('2026-10-14T10:00:00.000') }))
      .toMatchObject({ amount: '10.04', currency: 'CNY', band: 'peak', priceVersion: 'deepseek-flash@2026-10-10', holidayCalendarMissing: true })
  })

  it('flags holidayCalendarMissing only on peak quotes (off-peak and weekend quotes omit it)', () => {
    const q = quote(c, { provider: 'deepseek', model: 'deepseek-flash', usage: u, at: sh('2026-10-14T12:30:00.000') })!
    expect(q.amount).toBe('5.02')
    expect(q.band).toBe('offpeak')
    expect('holidayCalendarMissing' in q).toBe(false) // weekday, calendar missing, but off-peak: nothing to overestimate
    const weekend = quote(c, { provider: 'deepseek', model: 'deepseek-v4-pro', usage: u, at: sh('2026-10-17T10:00:00.000') })!
    expect('holidayCalendarMissing' in weekend).toBe(false)
  })

  it('forces the requested band at a peak instant', () => {
    const forced = quote(c, { provider: 'deepseek', model: 'deepseek-flash', usage: u, at: sh('2026-10-14T10:00:00.000'), band: 'offpeak' })!
    expect(forced.amount).toBe('5.02')
    expect(forced.band).toBe('offpeak')
    expect('holidayCalendarMissing' in forced).toBe(false)
    expect(quote(c, { provider: 'deepseek', model: 'deepseek-flash', usage: u, at: sh('2026-10-14T10:00:00.000'), band: 'flat' })).toBeNull()
  })

  it('prices pro at peak and off-peak', () => {
    expect(quote(c, { provider: 'deepseek', model: 'deepseek-v4-pro', usage: u, at: sh('2026-10-14T10:00:00.000') })!.amount).toBe('36.3')
    expect(quote(c, { provider: 'deepseek', model: 'deepseek-v4-pro', usage: u, at: sh('2026-10-17T10:00:00.000') })!.amount).toBe('18.15')
  })

  it('resolves aliases', () => {
    expect(quote(c, { provider: 'deepseek', model: 'deepseek-v4-flash', usage: u, at: sh('2026-10-14T10:00:00.000') })!.amount).toBe('10.04')
    expect(quote(c, { provider: 'deepseek', model: 'deepseek-v4-flash-vision-exp', usage: u, at: sh('2026-10-14T10:00:00.000') })!.priceVersion).toBe('deepseek-flash@2026-10-10')
  })

  it('returns an exact breakdown', () => {
    const usage = { inputTokens: 1234, cacheReadTokens: 5678, cacheWriteTokens: 0, outputTokens: 910 }
    expect(quote(c, { provider: 'deepseek', model: 'deepseek-flash', usage, at: sh('2026-10-14T10:00:00.000') })!.breakdown)
      .toEqual({ input: '0.002468', cacheRead: '0.00022712', cacheWrite: '0', output: '0.00728', reasoning: '0' })
  })

  it('returns null when nothing can be priced', () => {
    expect(quote(c, { provider: 'deepseek', model: 'deepseek-flash', usage: u, at: sh('2026-10-09T10:00:00.000') })).toBeNull() // before the first verified version
    expect(quote(c, { provider: 'deepseek', model: 'no-such-model', usage: u, at: sh('2026-10-14T10:00:00.000') })).toBeNull()
    expect(quote(c, { provider: 'acme', model: 'x', usage: u, at: sh('2026-10-14T10:00:00.000') })).toBeNull()
  })

  it('returns null for cache writes when no cacheWrite rate is given', () => {
    const usage = { ...u, cacheWriteTokens: 1 }
    expect(quote(c, { provider: 'deepseek', model: 'deepseek-flash', usage, at: sh('2026-10-14T10:00:00.000') })).toBeNull()
  })

  it('treats omitted optional token counts as zero', () => {
    const q = quote(c, { provider: 'deepseek', model: 'deepseek-flash', usage: { inputTokens: M, outputTokens: M }, at: sh('2026-10-14T10:00:00.000') })!
    expect(q.amount).toBe('10')
  })
})

describe('quote edge cases', () => {
  const src = { url: 'fixture', retrievedAt: '2026-10-10' }
  const rates = { input: '1', output: '2' }
  const make = (reasoningBilledAs: 'output' | 'separate' | 'free', versions: PriceCatalog['providers'][string]['models'][string]): PriceCatalog => ({
    schemaVersion: 1,
    generatedAt: '2026-10-10',
    providers: { p: { currency: 'USD', unit: 'per_million_tokens', reasoningBilledAs, models: { m: versions } } },
    holidays: {},
  })
  const v1 = { id: 'm@1', effectiveFrom: '2026-01-01T00:00:00+08:00', effectiveTo: '2026-06-01T00:00:00+08:00', rates: { flat: rates }, source: src }
  const v2 = { id: 'm@2', effectiveFrom: '2026-06-01T00:00:00+08:00', rates: { flat: { input: '3', output: '4' } }, source: src }
  const at = (iso: string) => Date.parse(iso)

  it('selects the version by half-open effective interval', () => {
    const cat = make('output', [v1, v2])
    expect(quote(cat, { provider: 'p', model: 'm', usage: { inputTokens: M, outputTokens: 0 }, at: at('2026-05-31T15:59:59.999Z') })!.priceVersion).toBe('m@1')
    expect(quote(cat, { provider: 'p', model: 'm', usage: { inputTokens: M, outputTokens: 0 }, at: at('2026-05-31T16:00:00.000Z') })!.amount).toBe('3')
  })

  it('uses the flat band when there are no windows and returns null for a missing band', () => {
    const cat = make('output', [v2])
    expect(quote(cat, { provider: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1 }, at: at('2026-07-01T00:00:00Z') })!.band).toBe('flat')
    const peakOnly = make('output', [{ ...v2, windows: { tz: 'Asia/Shanghai', peak: ['09:00-12:00'], days: [1, 2, 3, 4, 5] }, rates: { peak: rates } }])
    expect(quote(peakOnly, { provider: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1 }, at: sh('2026-10-14T13:00:00.000') })).toBeNull()
  })

  it('bills reasoning tokens according to reasoningBilledAs', () => {
    // Reasoning tokens are a subset of outputTokens: "output" and "free" add nothing on top.
    const usage = { inputTokens: 0, outputTokens: M, reasoningTokens: M / 2 }
    const at0 = at('2026-07-01T00:00:00Z')
    for (const mode of ['output', 'free'] as const) {
      const q = quote(make(mode, [v2]), { provider: 'p', model: 'm', usage, at: at0 })!
      expect(q.breakdown.reasoning).toBe('0')
      expect(q.amount).toBe('4')
    }
  })

  it('returns null for reasoningBilledAs "separate" instead of double-counting reasoning', () => {
    const at0 = at('2026-07-01T00:00:00Z')
    const cat = make('separate', [v2])
    expect(quote(cat, { provider: 'p', model: 'm', usage: { inputTokens: 0, outputTokens: M, reasoningTokens: M / 2 }, at: at0 })).toBeNull()
    expect(quote(cat, { provider: 'p', model: 'm', usage: { inputTokens: M, outputTokens: 0 }, at: at0 })).toBeNull()
  })

  it('returns null for cache reads without a cacheRead rate, and for unsupported tiers', () => {
    const cat = make('output', [v2])
    expect(quote(cat, { provider: 'p', model: 'm', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1 }, at: at('2026-07-01T00:00:00Z') })).toBeNull()
    const tiered = make('output', [{ ...v2, tiers: [{ minInputTokens: 100, multiplier: '2' }] }])
    expect(quote(tiered, { provider: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1 }, at: at('2026-07-01T00:00:00Z') })).toBeNull()
  })

  it('prices cache writes when a rate exists', () => {
    const cat = make('output', [{ ...v2, rates: { flat: { input: '1', output: '2', cacheWrite: '1.25' } } }])
    const q = quote(cat, { provider: 'p', model: 'm', usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: M }, at: at('2026-07-01T00:00:00Z') })!
    expect(q.breakdown.cacheWrite).toBe('1.25')
  })
})

describe('bandAt', () => {
  it('reports the band and when it next changes', () => {
    expect(bandAt(c, { provider: 'deepseek', model: 'deepseek-flash', at: sh('2026-10-14T10:00:00.000') }))
      .toEqual({ band: 'peak', until: sh('2026-10-14T12:00:00.000'), holidayCalendarMissing: true })
    expect(bandAt(c, { provider: 'deepseek', model: 'deepseek-v4-flash', at: sh('2026-10-17T10:00:00.000') }))
      .toEqual({ band: 'offpeak', until: sh('2026-10-19T09:00:00.000'), holidayCalendarMissing: false })
  })

  it('is null when nothing can be priced', () => {
    expect(bandAt(c, { provider: 'deepseek', model: 'deepseek-flash', at: sh('2026-10-09T10:00:00.000') })).toBeNull()
    expect(bandAt(c, { provider: 'acme', model: 'x', at: sh('2026-10-14T10:00:00.000') })).toBeNull()
  })
})
