import { describe, expect, it } from 'vitest'
import { loadCatalog } from 'dsh-pricing-data'
import { TallyPricing } from '../src/pricing-service.js'
import { aggregate } from '../src/query.js'
import type { StoredEntry } from '../src/store.js'

const DAY = 86_400_000
const N = 100_000

describe('aggregate performance', () => {
  it('aggregates 100k entries over 30 days by day in under 1000ms', () => {
    const pricing = new TallyPricing(loadCatalog(), { providerRoutes: { 'deepseek-official': 'deepseek' }, overrides: [] })
    const start = Date.parse('2026-10-11T00:00:00+08:00')
    const entries: StoredEntry[] = Array.from({ length: N }, (_, i) => ({
      id: `s${i % 50}:${i}`,
      sessionId: `s${i % 50}`,
      rootSessionId: `s${i % 50}`,
      workspaceId: '/w',
      at: start + Math.floor((i / N) * 30 * DAY),
      route: 'deepseek-official',
      model: 'deepseek-flash',
      tokens: { input: 1000 + (i % 7), cacheRead: 5000, cacheWrite: 0, output: 200 + (i % 13) },
      usageKnown: true,
      deleted: false,
    }))

    aggregate(entries.slice(0, 2000), pricing, 'day', 'Asia/Shanghai') // warm-up
    const t0 = performance.now()
    const groups = aggregate(entries, pricing, 'day', 'Asia/Shanghai')
    const elapsed = performance.now() - t0
    console.log(`aggregate(100k, day) took ${elapsed.toFixed(1)}ms`)

    expect(groups).toHaveLength(30)
    expect(groups.reduce((n, g) => n + g.requestCount, 0)).toBe(N)
    expect(groups.every(g => g.unpricedCount === 0 && g.cost.length === 1)).toBe(true)
    expect(elapsed).toBeLessThan(1000)
  })
})
