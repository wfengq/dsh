import { describe, expect, it } from 'vitest'
import { loadCatalog } from 'dsh-pricing-data'
import type { ProviderPriceOverride } from 'dsh-tally-api'
import { TallyPricing } from '../src/pricing-service.js'

const M = 1_000_000
const sh = (iso: string) => Date.parse(iso + '+08:00')
const wed10 = sh('2026-10-14T10:00:00.000')
const u = { inputTokens: M, cacheReadTokens: M, cacheWriteTokens: 0, outputTokens: M }
const providerRoutes = { 'deepseek-official': 'deepseek', 'deepseek-account': 'deepseek' }
const catalog = loadCatalog()

function make(overrides: ProviderPriceOverride[] = [], routes: Record<string, string> = providerRoutes) {
  return new TallyPricing(catalog, { providerRoutes: routes, overrides })
}

describe('TallyPricing', () => {
  it('maps DeepSeek routes onto the deepseek vendor', () => {
    expect(make().quoteRoute('deepseek-account', 'deepseek-flash', u, wed10)).toMatchObject({ amount: '10.04', currency: 'CNY' })
    expect(make().quoteRoute('deepseek-official', 'deepseek-flash', u, wed10)?.amount).toBe('10.04')
  })

  it('returns null for an unmapped gateway route', () => {
    expect(make().quoteRoute('my-gateway', 'deepseek-flash', u, wed10)).toBeNull()
  })

  it('does not treat a route that equals a vendor name specially beyond the default identity mapping', () => {
    expect(make().quoteRoute('deepseek', 'deepseek-flash', u, wed10)?.amount).toBe('10.04')
  })

  it('does not resolve prototype keys as routes', () => {
    expect(make().quoteRoute('constructor', 'deepseek-flash', u, wed10)).toBeNull()
    expect(make().quoteRoute('__proto__', 'deepseek-flash', u, wed10)).toBeNull()
  })

  it('applies an alias override to the target vendor', () => {
    const p = make([{ provider: 'my-gateway', kind: 'alias', target: { provider: 'deepseek' } }])
    expect(p.quoteRoute('my-gateway', 'deepseek-flash', u, wed10)?.amount).toBe('10.04')
  })

  it('applies an alias override with a target model', () => {
    const p = make([{ provider: 'my-gateway', kind: 'alias', target: { provider: 'deepseek', model: 'deepseek-flash' } }])
    expect(p.quoteRoute('my-gateway', 'whatever', u, wed10)?.amount).toBe('10.04')
  })

  it('prices a manual override with exact decimals and flat band', () => {
    const p = make([{ provider: 'my-gateway', kind: 'manual', currency: 'USD', models: { m: { input: '1', output: '2' } } }])
    const usage = { inputTokens: M, outputTokens: M, cacheReadTokens: 0, cacheWriteTokens: 0 }
    expect(p.quoteRoute('my-gateway', 'm', usage, wed10)).toMatchObject({
      amount: '3',
      currency: 'USD',
      band: 'flat',
      priceVersion: 'manual:my-gateway',
      breakdown: { input: '1', cacheRead: '0', cacheWrite: '0', output: '2', reasoning: '0' },
    })
  })

  it('keeps manual money exact (no floats)', () => {
    const p = make([{ provider: 'g', kind: 'manual', currency: 'CNY', models: { m: { input: '0.1', output: '0.2' } } }])
    const q = p.quoteRoute('g', 'm', { inputTokens: 3, outputTokens: 3 }, wed10)!
    expect(q.amount).toBe('0.0000009')
  })

  it('returns null when a manual override lacks a rate for a used dimension', () => {
    const p = make([{ provider: 'g', kind: 'manual', currency: 'USD', models: { m: { input: '1', output: '2' } } }])
    expect(p.quoteRoute('g', 'm', { inputTokens: M, outputTokens: M, cacheReadTokens: 1 }, wed10)).toBeNull()
    expect(p.quoteRoute('g', 'm', { inputTokens: M, outputTokens: M, cacheReadTokens: 0 }, wed10)?.amount).toBe('3')
  })

  it('returns null for a manual override that lacks the model, and never prices as zero', () => {
    const p = make([{ provider: 'g', kind: 'manual', currency: 'USD', models: { m: { input: '1', output: '2' } } }])
    expect(p.quoteRoute('g', 'other', u, wed10)).toBeNull()
    expect(p.quoteRoute('g', 'constructor', u, wed10)).toBeNull()
  })

  it('takes manual overrides ahead of route mapping', () => {
    const p = make([{ provider: 'deepseek-account', kind: 'manual', currency: 'USD', models: { 'deepseek-flash': { input: '1', output: '1' } } }])
    expect(p.quoteRoute('deepseek-account', 'deepseek-flash', { inputTokens: M, outputTokens: M }, wed10)).toMatchObject({ amount: '2', currency: 'USD' })
  })

  it('implements PricingService', () => {
    const overrides: ProviderPriceOverride[] = [{ provider: 'my-gateway', kind: 'alias', target: { provider: 'deepseek' } }]
    const p = make(overrides)
    expect(p.quote({ provider: 'my-gateway', model: 'deepseek-flash', usage: u, at: wed10 })?.amount).toBe('10.04')
    expect(p.catalogVersion()).toBe(catalog.generatedAt)
    expect(p.overrides()).toEqual(overrides)
  })
})
