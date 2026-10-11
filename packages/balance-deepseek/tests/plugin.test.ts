import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { BalanceFetcher } from 'dsh-tally-api'
import * as plugin from '../src/index.js'

// Service state lives in plain objects: cordis proxies service instances.
interface Recorder {
  registered: Map<string, BalanceFetcher>
  unregistered: string[]
}

class FakeTallyBalance extends Service {
  constructor(ctx: Context, private readonly rec: Recorder) {
    super(ctx, 'tallyBalance')
  }

  register(provider: string, fetcher: BalanceFetcher): () => void {
    const { registered, unregistered } = this.rec
    registered.set(provider, fetcher)
    return () => {
      registered.delete(provider)
      unregistered.push(provider)
    }
  }
}

class FakeCredentials extends Service {
  constructor(ctx: Context, private readonly values: Record<string, string>) {
    super(ctx, 'credentials')
  }

  async resolve(ref: string) {
    const value = this.values[ref]
    return value === undefined ? undefined : { value, source: 'env' }
  }
}

class FakeAccount extends Service {
  constructor(ctx: Context, private readonly calls: unknown[]) {
    super(ctx, 'deepseekAccount')
  }

  async getBalance(client: unknown) {
    this.calls.push(client)
    return { status: 'ready' as const, value: [{ currency: 'USD' as const, balance: '3' }], bonusWallets: [] }
  }
}

type Fiber = { dispose(): Promise<void> }

let ctx: Context
let rec: Recorder
let server: Server
let baseURL: string
let seenAuth: string | undefined
const credentialValues: Record<string, string> = {}
const accountCalls: unknown[] = []

beforeEach(async () => {
  ctx = new Context()
  rec = { registered: new Map(), unregistered: [] }
  seenAuth = undefined
  accountCalls.length = 0
  for (const k of Object.keys(credentialValues)) delete credentialValues[k]
  credentialValues.DEEPSEEK_API_KEY = 'sk-test-123'
  server = createServer((req, res) => {
    seenAuth = req.headers.authorization
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '9', granted_balance: '4', topped_up_balance: '5' }],
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function load(fiber: Fiber & PromiseLike<unknown>): Promise<Fiber> {
  await fiber
  // A thenable fiber must not be returned from an async function, or it would be awaited again.
  return { dispose: () => fiber.dispose() }
}

async function mount(config: Partial<plugin.Config> = {}): Promise<void> {
  await load(ctx.plugin(FakeTallyBalance, rec))
  await load(ctx.plugin(plugin, plugin.Config({ baseURL, ...config })))
}

describe('dsh-tally-balance-deepseek plugin', () => {
  it('declares its name, dependency and defaults', () => {
    expect(plugin.name).toBe('dsh-tally-balance-deepseek')
    expect(plugin.inject).toEqual(['tallyBalance'])
    expect(plugin.Config({})).toEqual({
      baseURL: 'https://api.deepseek.com',
      apiKeyRef: 'DEEPSEEK_API_KEY',
      officialRoute: 'deepseek-official',
      accountRoute: 'deepseek-account',
    })
  })

  it('registers both routes once their services are present', async () => {
    await mount()
    expect([...rec.registered.keys()]).toEqual([])
    await load(ctx.plugin(FakeCredentials, credentialValues))
    expect([...rec.registered.keys()]).toEqual(['deepseek-official'])
    await load(ctx.plugin(FakeAccount, accountCalls))
    expect([...rec.registered.keys()].sort()).toEqual(['deepseek-account', 'deepseek-official'])
  })

  it('unregisters the official route when credentials go away', async () => {
    await mount()
    const credentials = await load(ctx.plugin(FakeCredentials, credentialValues))
    const account = await load(ctx.plugin(FakeAccount, accountCalls))
    await credentials.dispose()
    expect(rec.unregistered).toEqual(['deepseek-official'])
    expect([...rec.registered.keys()]).toEqual(['deepseek-account'])
    await account.dispose()
    expect(rec.unregistered).toEqual(['deepseek-official', 'deepseek-account'])
    expect(rec.registered.size).toBe(0)
  })

  it('unregisters both routes when the plugin itself is disposed', async () => {
    await load(ctx.plugin(FakeTallyBalance, rec))
    const fiber = await load(ctx.plugin(plugin, plugin.Config({ baseURL })))
    await load(ctx.plugin(FakeCredentials, credentialValues))
    await load(ctx.plugin(FakeAccount, accountCalls))
    expect(rec.registered.size).toBe(2)
    await fiber.dispose()
    expect(rec.registered.size).toBe(0)
    expect([...rec.unregistered].sort()).toEqual(['deepseek-account', 'deepseek-official'])
  })

  it('fetches the official balance through the registered fetcher', async () => {
    await mount()
    await load(ctx.plugin(FakeCredentials, credentialValues))
    const wallets = await rec.registered.get('deepseek-official')!(new AbortController().signal)
    expect(wallets.map((w) => w.money.amount)).toEqual(['5', '4', '9'])
    expect(seenAuth).toBe('Bearer sk-test-123')
  })

  it('reports a missing key without leaking anything', async () => {
    await mount()
    delete credentialValues.DEEPSEEK_API_KEY
    await load(ctx.plugin(FakeCredentials, credentialValues))
    await expect(rec.registered.get('deepseek-official')!(new AbortController().signal))
      .rejects.toThrow('DEEPSEEK_API_KEY not configured')
  })

  it('honours custom route ids and credential name', async () => {
    await mount({ officialRoute: 'o', accountRoute: 'a', apiKeyRef: 'MY_KEY' })
    delete credentialValues.DEEPSEEK_API_KEY
    credentialValues.MY_KEY = 'sk-other'
    await load(ctx.plugin(FakeCredentials, credentialValues))
    await load(ctx.plugin(FakeAccount, accountCalls))
    expect([...rec.registered.keys()].sort()).toEqual(['a', 'o'])
    await rec.registered.get('o')!(new AbortController().signal)
    expect(seenAuth).toBe('Bearer sk-other')
  })

  it('fetches the account balance with the pinned client metadata', async () => {
    await mount()
    await load(ctx.plugin(FakeAccount, accountCalls))
    const wallets = await rec.registered.get('deepseek-account')!(new AbortController().signal)
    expect(wallets).toEqual([
      { kind: 'topup', money: { amount: '3', currency: 'USD' } },
      { kind: 'granted', money: { amount: '0', currency: 'USD' } },
      { kind: 'total', money: { amount: '3', currency: 'USD' } },
    ])
    expect(accountCalls).toEqual([
      { version: '0.2.0-rc.2', locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 },
    ])
  })
})
