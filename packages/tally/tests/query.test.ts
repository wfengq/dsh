import { describe, expect, it } from 'vitest'
import { loadCatalog, type PriceCatalog } from 'dsh-pricing-data'
import type { ProviderPriceOverride } from 'dsh-tally-api'
import { TallyPricing } from '../src/pricing-service.js'
import { aggregate, sessionUsage } from '../src/query.js'
import type { StoredEntry } from '../src/store.js'

const M = 1_000_000
const sh = (iso: string) => Date.parse(iso + '+08:00')
const p = new TallyPricing(loadCatalog(), {
  providerRoutes: { 'deepseek-official': 'deepseek', 'deepseek-account': 'deepseek' },
  overrides: [],
})

function entry(over: Partial<StoredEntry>): StoredEntry {
  return {
    id: 's:1',
    sessionId: 's',
    rootSessionId: 's',
    workspaceId: '/w',
    at: sh('2026-10-14T10:00:00.000'),
    route: 'deepseek-official',
    model: 'deepseek-flash',
    tokens: { input: M, cacheRead: M, cacheWrite: 0, output: M },
    usageKnown: true,
    deleted: false,
    ...over,
  }
}

const A = entry({ id: 'a:1' })
const B = entry({ id: 'b:1', at: sh('2026-10-14T12:30:00.000') })
const C = entry({ id: 'c:1', route: 'my-gateway', model: 'x' })
const D = entry({ id: 'd:1', model: 'unk', tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, usageKnown: false })

describe('aggregate', () => {
  it('groups by model with per-currency cost and counters', () => {
    const groups = aggregate([A, B, C, D], p, 'model', 'Asia/Shanghai')
    expect(groups.map(g => g.key)).toEqual(['deepseek-flash', 'unk', 'x'])
    const flash = groups.find(g => g.key === 'deepseek-flash')!
    expect(flash.cost).toEqual([{ amount: '15.06', currency: 'CNY' }])
    expect(flash.requestCount).toBe(2)
    expect(flash.unpricedCount).toBe(0)
    expect(flash.tokens).toEqual({ input: 2 * M, cacheRead: 2 * M, cacheWrite: 0, output: 2 * M })
    const x = groups.find(g => g.key === 'x')!
    expect(x.unpricedCount).toBe(1)
    expect(x.cost).toEqual([])
    const unk = groups.find(g => g.key === 'unk')!
    expect(unk.unknownUsageCount).toBe(1)
    expect(unk.unpricedCount).toBe(0)
    expect(unk.cost).toEqual([])
  })

  it('groups by day in the requested time zone', () => {
    expect(aggregate([A], p, 'day', 'America/Los_Angeles').map(g => g.key)).toEqual(['2026-10-13'])
    expect(aggregate([A], p, 'day', 'Asia/Shanghai').map(g => g.key)).toEqual(['2026-10-14'])
    // 23:30 Shanghai is still the same day; 00:30 is the next.
    const late = entry({ at: sh('2026-10-14T23:30:00.000') })
    const next = entry({ at: sh('2026-10-15T00:30:00.000') })
    expect(aggregate([next, late, A], p, 'day', 'Asia/Shanghai').map(g => g.key)).toEqual(['2026-10-14', '2026-10-15'])
  })

  it('sorts groups by key ascending', () => {
    const groups = aggregate([entry({ model: 'z' }), entry({ model: 'a' }), entry({ model: 'm' })], p, 'model', 'UTC')
    expect(groups.map(g => g.key)).toEqual(['a', 'm', 'z'])
  })

  it('groups by provider (route mapped to its vendor), workspace and session', () => {
    expect(aggregate([A, C], p, 'provider', 'UTC').map(g => g.key)).toEqual(['deepseek', 'my-gateway'])
    const w = aggregate([A, entry({ workspaceId: '/a' }), entry({ workspaceId: null })], p, 'workspace', 'UTC')
    expect(w.map(g => g.key)).toEqual(['', '/a', '/w'])
    expect(aggregate([A, entry({ sessionId: 'z' })], p, 'session', 'UTC').map(g => g.key)).toEqual(['s', 'z'])
  })

  it('keeps one cost per currency without converting', () => {
    const usd = new TallyPricing(loadCatalog(), {
      providerRoutes: {},
      overrides: [{ provider: 'g', kind: 'manual', currency: 'USD', models: { m: { input: '1', output: '2' } } }],
    })
    const g = entry({ route: 'g', model: 'm', tokens: { input: M, cacheRead: 0, cacheWrite: 0, output: M } })
    const groups = aggregate([entry({ route: 'deepseek' }), g], usd, 'day', 'Asia/Shanghai')
    expect(groups).toHaveLength(1)
    expect([...groups[0].cost].sort((a, b) => a.currency.localeCompare(b.currency))).toEqual([
      { amount: '10.04', currency: 'CNY' },
      { amount: '3', currency: 'USD' },
    ])
  })

  it('sums high-precision amounts exactly', () => {
    const small = entry({ tokens: { input: 1, cacheRead: 1, cacheWrite: 0, output: 1 } })
    const groups = aggregate([small, small, small], p, 'model', 'UTC')
    // One token of each billed dimension at the peak rates 2 + 0.04 + 8 per million = 0.00001004 per entry.
    expect(groups[0].cost).toEqual([{ amount: '0.00003012', currency: 'CNY' }])
  })

  it('counts reasoning tokens only when present', () => {
    const r = aggregate([entry({ tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 5 } }), entry({})], p, 'model', 'UTC')
    expect(r[0].tokens.reasoning).toBe(5)
    expect('reasoning' in aggregate([entry({})], p, 'model', 'UTC')[0].tokens).toBe(false)
  })

  it('returns no groups for no entries', () => {
    expect(aggregate([], p, 'day', 'UTC')).toEqual([])
  })
})

describe('sessionUsage', () => {
  const r = entry({ id: 'r:1', sessionId: 'r', rootSessionId: 'r' })
  const c1 = entry({ id: 'c1:1', sessionId: 'c1', rootSessionId: 'r' })
  const c2 = entry({ id: 'c2:1', sessionId: 'c2', rootSessionId: 'r', route: 'my-gateway' })

  it('totals the whole tree and breaks down children', () => {
    const su = sessionUsage([r, c1, c2], 'r', p)
    expect(su.sessionId).toBe('r')
    expect(su.total.cost).toEqual([{ amount: '20.08', currency: 'CNY' }])
    expect(su.total.requestCount).toBe(3)
    expect(su.total.unpricedCount).toBe(1)
    expect(su.children).toHaveLength(2)
    expect(su.children.map(c => c.sessionId)).toEqual(['c1', 'c2'])
    expect(su.children[0].total.cost).toEqual([{ amount: '10.04', currency: 'CNY' }])
    expect(su.children[1].total.unpricedCount).toBe(1)
  })

  it('returns an empty total for a session without entries', () => {
    const su = sessionUsage([], 'r', p)
    expect(su.total).toMatchObject({ key: 'r', requestCount: 0, cost: [] })
    expect(su.children).toEqual([])
  })
})

describe('aggregate rate caching', () => {
  // Peak boundary at 09:05 and a price change at 10:07 fall inside 15-minute buckets.
  const src = { url: 'fixture', retrievedAt: '2026-10-10' }
  const catalog: PriceCatalog = {
    schemaVersion: 1,
    generatedAt: '2026-10-10',
    holidays: {},
    providers: {
      v: {
        currency: 'USD',
        unit: 'per_million_tokens',
        reasoningBilledAs: 'output',
        models: {
          m: [
            {
              id: 'm@1',
              effectiveFrom: '2026-10-01T00:00:00Z',
              effectiveTo: '2026-10-14T10:07:00Z',
              windows: { tz: 'UTC', peak: ['09:05-12:00'], days: [1, 2, 3, 4, 5, 6, 7] },
              rates: { peak: { input: '3', cacheRead: '0.3', output: '9' }, offpeak: { input: '1', cacheRead: '0.1', output: '3' } },
              source: src,
            },
            {
              id: 'm@2',
              effectiveFrom: '2026-10-14T10:07:00Z',
              windows: { tz: 'UTC', peak: ['09:05-12:00'], days: [1, 2, 3, 4, 5, 6, 7] },
              rates: { peak: { input: '4', cacheRead: '0.4', cacheWrite: '5', output: '7.123456789' }, offpeak: { input: '1', cacheRead: '0.1', output: '3' } },
              source: src,
            },
          ],
        },
      },
    },
  }
  const pricing = new TallyPricing(catalog, { providerRoutes: {}, overrides: [] })

  it('matches uncached quotes exactly, including mid-bucket boundaries and missing rates', () => {
    const base = Date.parse('2026-10-14T08:50:00Z')
    const entries: StoredEntry[] = []
    for (let min = 0; min < 150; min++) {
      for (const [i, tokens] of [
        { input: 12345, cacheRead: 678, cacheWrite: 0, output: 91 },
        { input: 7, cacheRead: 3, cacheWrite: 0, output: 1, reasoning: 5 },
        { input: 99, cacheRead: 0, cacheWrite: 4, output: 2 },
      ].entries()) {
        entries.push(entry({ id: `e:${min}:${i}`, route: 'v', model: 'm', at: base + min * 60_000, tokens }))
      }
    }
    // Expected: price every entry individually through quoteRoute.
    let expectedUnits = 0n
    let unpriced = 0
    for (const e of entries) {
      const q = pricing.quoteRoute(e.route, e.model, {
        inputTokens: e.tokens.input,
        cacheReadTokens: e.tokens.cacheRead,
        cacheWriteTokens: e.tokens.cacheWrite,
        outputTokens: e.tokens.output,
        reasoningTokens: e.tokens.reasoning,
      }, e.at)
      if (q === null) { unpriced++; continue }
      const [w, f = ''] = q.amount.split('.')
      expectedUnits += BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, '0'))
    }
    expect(unpriced).toBeGreaterThan(0)
    const [g] = aggregate(entries, pricing, 'model', 'UTC')
    const whole = expectedUnits / 10n ** 18n
    const frac = (expectedUnits % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
    expect(g.unpricedCount).toBe(unpriced)
    expect(g.cost).toEqual([{ amount: frac ? `${whole}.${frac}` : `${whole}`, currency: 'USD' }])
  })

  it('stays identical to quoteRoute when the band flips and flips back inside one bucket', () => {
    const flip: PriceCatalog = {
      ...catalog,
      providers: {
        v: {
          ...catalog.providers.v,
          reasoningBilledAs: 'output',
          models: {
            m: [{
              id: 'm@1',
              effectiveFrom: '2026-10-01T00:00:00Z',
              windows: { tz: 'UTC', peak: ['09:00-09:05', '09:10-12:00'], days: [1, 2, 3, 4, 5, 6, 7] },
              rates: { peak: { input: '10', cacheRead: '1', output: '10' }, offpeak: { input: '1', cacheRead: '0.1', output: '1' } },
              source: src,
            }],
          },
        },
      },
    }
    const p = new TallyPricing(flip, { providerRoutes: {}, overrides: [] })
    const at = Date.parse('2026-10-14T09:07:00Z')
    const e = entry({ route: 'v', model: 'm', at, tokens: { input: M, cacheRead: 0, cacheWrite: 0, output: 0 } })
    expect(p.quoteRoute('v', 'm', { inputTokens: M, outputTokens: 0 }, at)?.amount).toBe('1')
    const entries = [e]
    for (let min = 0; min < 30; min++) entries.push({ ...e, id: `f:${min}`, at: Date.parse('2026-10-14T09:00:00Z') + min * 60_000 })
    let expected = 0
    for (const x of entries) expected += Number(p.quoteRoute('v', 'm', { inputTokens: M, outputTokens: 0 }, x.at)!.amount)
    const [g] = aggregate(entries, p, 'model', 'UTC')
    expect(g.cost).toEqual([{ amount: String(expected), currency: 'USD' }])
  })

  it('does not use the cache for unaligned zone offsets but still matches quoteRoute', () => {
    const odd: PriceCatalog = {
      ...catalog,
      providers: {
        v: {
          ...catalog.providers.v,
          models: {
            m: [{
              id: 'm@1',
              effectiveFrom: '2026-10-01T00:00:00Z',
              windows: { tz: 'Asia/Kathmandu', peak: ['09:00-12:00'], days: [1, 2, 3, 4, 5, 6, 7] },
              rates: { peak: { input: '10', cacheRead: '1', output: '10' }, offpeak: { input: '1', cacheRead: '0.1', output: '1' } },
              source: src,
            }],
          },
        },
      },
    }
    const p = new TallyPricing(odd, { providerRoutes: {}, overrides: [] })
    const entries: StoredEntry[] = []
    for (let min = 0; min < 24 * 60; min += 5) {
      entries.push(entry({ id: `k:${min}`, route: 'v', model: 'm', at: Date.parse('2026-10-14T00:00:00Z') + min * 60_000, tokens: { input: M, cacheRead: 0, cacheWrite: 0, output: 0 } }))
    }
    let expected = 0
    for (const x of entries) expected += Number(p.quoteRoute('v', 'm', { inputTokens: M, outputTokens: 0 }, x.at)!.amount)
    expect(aggregate(entries, p, 'model', 'UTC')[0].cost).toEqual([{ amount: String(expected), currency: 'USD' }])
  })
})
