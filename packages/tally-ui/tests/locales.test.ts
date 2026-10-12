import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

const REQUIRED = [
  'status.unavailable', 'band.peak', 'band.offpeak', 'band.flat', 'band.countdown',
  'money.unpriced', 'balance.stale', 'balance.notConfigured', 'balance.signedOut', 'balance.failed',
  'dock.session', 'dock.today', 'dock.balance',
  'turn.cost', 'turn.input', 'turn.cacheRead', 'turn.output', 'turn.hitRate', 'turn.requests', 'turn.priceVersion', 'turn.source',
  'header.total', 'header.subagents',
  'tab.title', 'tab.range.today', 'tab.range.7d', 'tab.range.30d', 'tab.range.month', 'tab.byModel', 'tab.byWorkspace', 'tab.bySession',
  'tab.hitRateTrend', 'tab.savings', 'tab.export', 'tab.unpriced', 'tab.unknownWorkspace', 'tab.deleted',
  'settings.nav', 'settings.catalog', 'settings.overrides', 'settings.budgets', 'settings.elements', 'settings.rebuild', 'settings.rebuildProgress',
  'alert.reached80', 'alert.reached100', 'disclaimer',
]

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()

describe('dictionaries', () => {
  it('have the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
  it('contain every required key', () => {
    for (const key of REQUIRED) expect(Object.keys(zh), key).toContain(key)
  })
  it('have no empty strings', () => {
    for (const [key, value] of [...Object.entries(zh), ...Object.entries(en)]) expect(value.trim(), key).not.toBe('')
  })
  it('use the same placeholders in both languages', () => {
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]))
  })
})
