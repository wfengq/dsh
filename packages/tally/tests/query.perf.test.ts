import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadCatalog } from 'dsh-pricing-data'
import { TallyPricing } from '../src/pricing-service.js'
import { aggregate } from '../src/query.js'
import { TallyStore, type StoredEntry } from '../src/store.js'

const DAY = 86_400_000
const N = 100_000
const START = Date.parse('2026-10-11T00:00:00+08:00')

const pricing = new TallyPricing(loadCatalog(), { providerRoutes: { 'deepseek-official': 'deepseek' }, overrides: [] })

function makeEntries(): StoredEntry[] {
  return Array.from({ length: N }, (_, i) => ({
    id: `s${i % 50}:${i}`,
    sessionId: `s${i % 50}`,
    rootSessionId: `s${i % 50}`,
    workspaceId: '/w',
    at: START + Math.floor((i / N) * 30 * DAY),
    route: 'deepseek-official',
    model: 'deepseek-flash',
    tokens: { input: 1000 + (i % 7), cacheRead: 5000, cacheWrite: 0, output: 200 + (i % 13) },
    usageKnown: true,
    deleted: false,
  }))
}

describe('aggregate performance', () => {
  it('aggregates 100k entries over 30 days by day in under 1000ms', () => {
    const entries = makeEntries()
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

describe('real query path performance', () => {
  let dir: string
  let store: TallyStore

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-tally-perf-'))
    store = TallyStore.open(join(dir, 'tally.v1.sqlite'))
    // Inserted in shuffled order, so the rows are not stored in time order.
    const entries = makeEntries()
    for (let i = entries.length - 1; i > 0; i--) {
      const j = (i * 7919) % (i + 1)
      ;[entries[i], entries[j]] = [entries[j]!, entries[i]!]
    }
    store.transaction(() => {
      for (const e of entries) store.upsertEntry(e)
    })
  })

  afterAll(() => {
    store?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads 100k rows from SQLite and aggregates them by day in under 1000ms', () => {
    const range = { from: START, to: START + 30 * DAY }
    // `store.usage` is the read behind `TallyUsage.query` and `TallyUsage.session`.
    aggregate(store.usage({ from: START, to: START + DAY / 4 }), pricing, 'day', 'Asia/Shanghai') // warm-up
    const t0 = performance.now()
    const entries = store.usage(range)
    const t1 = performance.now()
    const groups = aggregate(entries, pricing, 'day', 'Asia/Shanghai')
    const elapsed = performance.now() - t0
    console.log(`store.usage(100k) took ${(t1 - t0).toFixed(1)}ms, + aggregate(day) = ${elapsed.toFixed(1)}ms`)

    expect(entries).toHaveLength(N)
    expect(groups).toHaveLength(30)
    expect(groups.reduce((n, g) => n + g.requestCount, 0)).toBe(N)
    expect(groups.every(g => g.unpricedCount === 0 && g.cost.length === 1)).toBe(true)
    expect(elapsed).toBeLessThan(1000)
  })
})
