import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadCatalog } from 'dsh-pricing-data'
import type { ProviderPriceOverride } from 'dsh-tally-api'
import * as tally from '../src/index.js'
import { TallyPricing, type TallyPricingService } from '../src/pricing-service.js'

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

  it('rejects an alias override whose target provider or model is not in the catalog', () => {
    expect(() => make([{ provider: 'gw', kind: 'alias', target: { provider: 'nope' } }]))
      .toThrow(/gw.*target provider "nope" is not in the price catalog/)
    expect(() => make([{ provider: 'gw', kind: 'alias', target: { provider: 'constructor' } }])).toThrow(/constructor/)
    expect(() => make([{ provider: 'gw', kind: 'alias', target: { provider: 'deepseek', model: 'nope' } }]))
      .toThrow(/gw.*target model "nope" is not a model of "deepseek"/)
    // A catalog alias of a model is a valid target model.
    const p = make([{ provider: 'gw', kind: 'alias', target: { provider: 'deepseek', model: 'deepseek-v4-flash' } }])
    expect(p.quoteRoute('gw', 'x', u, wed10)?.amount).toBe('10.04')
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

describe('volatile price overrides', () => {
  let dir: string | undefined
  let root: Context | undefined

  afterEach(async () => {
    await root?.fiber.dispose()
    root = undefined
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  /** Mount dsh-tally as a real Loader entry, the way the settings service edits it. */
  async function mount(overrides: ProviderPriceOverride[]) {
    dir = mkdtempSync(join(tmpdir(), 'dsh-tally-volatile-'))
    const base = { dbPath: join(dir, 'tally.v1.sqlite'), budgetPath: join(dir, 'budgets.json') }
    root = new Context()
    root.baseUrl = pathToFileURL(dir).href + '/'
    await root.plugin(Loader)
    root.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === 'dsh-tally') return tally
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof root.loader.internal>
    const id = await root.loader.create({ name: 'dsh-tally', config: { ...base, overrides } })
    await root.loader.await()
    const loader = root.loader
    return {
      entry: () => loader.resolve(id),
      pricing: () => root!.get('tallyPricing') as unknown as TallyPricingService,
      async setOverrides(next: ProviderPriceOverride[]) {
        await loader.update(id, { config: { ...base, overrides: next } })
        await loader.await()
      },
    }
  }

  /**
   * Every `ctx.get` returns a fresh cordis proxy, so the instance is identified by its state
   * object, which a remount would create anew.
   */
  const stateOf = (service: TallyPricingService) => (service as unknown as { state: object }).state

  const gateway: ProviderPriceOverride = { provider: 'my-gateway', kind: 'alias', target: { provider: 'deepseek' } }
  const q = (provider: string) => ({ provider, model: 'deepseek-flash', usage: u, at: wed10 })

  it('re-prices an added alias override without remounting the plugin', async () => {
    const host = await mount([])
    const service = host.pricing()
    const fiber = host.entry().fiber
    expect(service.quote(q('my-gateway'))).toBeNull()

    await host.setOverrides([gateway])

    expect(stateOf(host.pricing()) === stateOf(service), 'same service instance').toBe(true)
    expect(host.entry().fiber === fiber, 'same fiber').toBe(true)
    expect(service.quote(q('my-gateway'))).toEqual(service.quote(q('deepseek')))
    expect(service.quote(q('my-gateway'))?.amount).toBe('10.04')
    expect(service.overrides()).toEqual([gateway])
    expect(service.configErrors).toEqual([])
    expect(service.pricing.catalogView(wed10).overrides).toEqual([gateway])
  })

  it('skips an invalid override from an update and reports it, then clears the error when it is removed', async () => {
    const host = await mount([gateway])
    const service = host.pricing()
    await host.setOverrides([gateway, { provider: 'gw-x', kind: 'alias', target: { provider: 'no-such-vendor' } }])
    expect(stateOf(host.pricing()) === stateOf(service), 'same service instance').toBe(true)
    expect(service.overrides()).toEqual([gateway])
    expect(service.configErrors.map(e => e.message)).toEqual([expect.stringContaining('"gw-x"')])
    expect(service.quote(q('gw-x'))).toBeNull()

    await host.setOverrides([])
    expect(service.configErrors).toEqual([])
    expect(service.quote(q('my-gateway'))).toBeNull()
  })

  it('notifies change observers when the pricing is rebuilt', async () => {
    const host = await mount([])
    const service = host.pricing()
    const seen: string[][] = []
    const stop = service.watchChanges(() => { seen.push(service.overrides().map(o => o.provider)) })
    await host.setOverrides([gateway])
    expect(seen).toEqual([['my-gateway']])
    stop()
    await host.setOverrides([])
    expect(seen).toEqual([['my-gateway']])
  })
})
