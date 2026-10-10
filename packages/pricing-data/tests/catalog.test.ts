import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadCatalog, validateCatalog } from '../src/index.js'

const raw = () => JSON.parse(readFileSync(new URL('../catalog.json', import.meta.url), 'utf8'))

describe('catalog.json', () => {
  it('is valid', () => {
    expect(validateCatalog(raw())).toEqual([])
    expect(() => loadCatalog()).not.toThrow()
  })

  it('records the verified DeepSeek data', () => {
    const c = loadCatalog()
    const ds = c.providers.deepseek
    expect(ds).toMatchObject({ currency: 'CNY', unit: 'per_million_tokens', reasoningBilledAs: 'output' })
    expect(ds.aliases).toEqual({ 'deepseek-v4-flash': 'deepseek-flash', 'deepseek-v4-flash-vision-exp': 'deepseek-flash' })
    expect(c.holidays).toEqual({ CN: { years: {} } })
  })
})

describe('validateCatalog', () => {
  it('rejects non-objects and a wrong schemaVersion', () => {
    expect(validateCatalog(null).length).toBeGreaterThan(0)
    expect(validateCatalog({ ...raw(), schemaVersion: 2 }).length).toBeGreaterThan(0)
  })

  it('rejects a version without source.url', () => {
    const c = raw()
    delete c.providers.deepseek.models['deepseek-flash'][0].source.url
    expect(validateCatalog(c).length).toBeGreaterThan(0)
  })

  it('rejects overlapping effective intervals of the same model', () => {
    const c = raw()
    const first = c.providers.deepseek.models['deepseek-flash'][0]
    c.providers.deepseek.models['deepseek-flash'] = [
      { ...first, id: 'a', effectiveFrom: '2026-01-01T00:00:00+08:00', effectiveTo: '2026-11-01T00:00:00+08:00' },
      { ...first, id: 'b', effectiveFrom: '2026-10-10T00:00:00+08:00' },
    ]
    expect(validateCatalog(c).length).toBeGreaterThan(0)
  })

  it('rejects reasoningBilledAs "separate" until its semantics are defined', () => {
    const c = raw()
    c.providers.deepseek.reasoningBilledAs = 'separate'
    const errors = validateCatalog(c)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('providers.deepseek.reasoningBilledAs')
    expect(errors[0]).toContain('"separate" is not supported')
    for (const ok of ['output', 'free']) {
      c.providers.deepseek.reasoningBilledAs = ok
      expect(validateCatalog(c)).toEqual([])
    }
  })

  it('accepts adjacent intervals', () => {
    const c = raw()
    const first = c.providers.deepseek.models['deepseek-flash'][0]
    c.providers.deepseek.models['deepseek-flash'] = [
      { ...first, id: 'a', effectiveFrom: '2026-01-01T00:00:00+08:00', effectiveTo: '2026-10-10T00:00:00+08:00' },
      { ...first, id: 'b', effectiveFrom: '2026-10-10T00:00:00+08:00' },
    ]
    expect(validateCatalog(c)).toEqual([])
  })

  it('rejects duplicate version ids, bad decimals, bad windows and dangling aliases', () => {
    const dup = raw()
    const flash = dup.providers.deepseek.models['deepseek-flash']
    dup.providers.deepseek.models['deepseek-v4-pro'][0].id = flash[0].id
    expect(validateCatalog(dup).length).toBeGreaterThan(0)

    const dec = raw()
    dec.providers.deepseek.models['deepseek-flash'][0].rates.peak.input = '1e3'
    expect(validateCatalog(dec).length).toBeGreaterThan(0)

    const win = raw()
    win.providers.deepseek.models['deepseek-flash'][0].windows.peak = ['9-12']
    expect(validateCatalog(win).length).toBeGreaterThan(0)

    const tz = raw()
    tz.providers.deepseek.models['deepseek-flash'][0].windows.tz = 'Not/AZone'
    expect(validateCatalog(tz).length).toBeGreaterThan(0)

    const alias = raw()
    alias.providers.deepseek.aliases['x'] = 'missing'
    expect(validateCatalog(alias).length).toBeGreaterThan(0)
  })

  it('rejects versions not sorted by effectiveFrom ascending', () => {
    const c = raw()
    const first = c.providers.deepseek.models['deepseek-flash'][0]
    c.providers.deepseek.models['deepseek-flash'] = [
      { ...first, id: 'b', effectiveFrom: '2026-10-10T00:00:00+08:00' },
      { ...first, id: 'a', effectiveFrom: '2026-01-01T00:00:00+08:00', effectiveTo: '2026-02-01T00:00:00+08:00' },
    ]
    expect(validateCatalog(c).length).toBeGreaterThan(0)
  })
})
