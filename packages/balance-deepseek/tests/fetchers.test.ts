import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountFetcher, apiKeyFetcher } from '../src/fetchers.js'

const KEY = 'sk-test-123'

const API_BODY = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
  ],
}

let server: Server
let baseURL: string
let received: { path?: string; headers?: IncomingHttpHeaders }
let respond: (res: import('node:http').ServerResponse) => void

beforeEach(async () => {
  received = {}
  respond = (res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(API_BODY))
  }
  server = createServer((req, res) => {
    received = { path: req.url, headers: req.headers }
    respond(res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const signal = () => new AbortController().signal

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describe('apiKeyFetcher', () => {
  it('returns the three wallets and sends the key as a bearer token', async () => {
    const fetcher = apiKeyFetcher({ baseURL, resolveKey: async () => KEY })
    const wallets = await fetcher(signal())
    expect(wallets).toEqual([
      { kind: 'topup', money: { amount: '100', currency: 'CNY' } },
      { kind: 'granted', money: { amount: '10', currency: 'CNY' } },
      { kind: 'total', money: { amount: '110', currency: 'CNY' } },
    ])
    expect(received.path).toBe('/user/balance')
    expect(received.headers?.authorization).toBe('Bearer sk-test-123')
    expect(received.headers?.accept).toBe('application/json')
  })

  it('ignores any path in baseURL and resolves the key on every call', async () => {
    let key = 'sk-first'
    const fetcher = apiKeyFetcher({ baseURL: baseURL + '/v1/ignored', resolveKey: async () => key })
    await fetcher(signal())
    expect(received.path).toBe('/user/balance')
    expect(received.headers?.authorization).toBe('Bearer sk-first')
    key = 'sk-second'
    await fetcher(signal())
    expect(received.headers?.authorization).toBe('Bearer sk-second')
  })

  it('throws a key-free error for a non-2xx response', async () => {
    respond = (res) => {
      res.statusCode = 401
      // A hostile or misconfigured upstream may echo the credential back.
      res.end(`bad key ${KEY}`)
    }
    const error = await errorOf(apiKeyFetcher({ baseURL, resolveKey: async () => KEY })(signal()))
    expect(error.message).toBe('DeepSeek balance: HTTP 401')
    expect(error.message).not.toContain(KEY)
    expect(String(error.stack)).not.toContain(KEY)
  })

  it('throws a key-free error for a body that is not JSON', async () => {
    respond = (res) => { res.end(`not json ${KEY}`) }
    const error = await errorOf(apiKeyFetcher({ baseURL, resolveKey: async () => KEY })(signal()))
    expect(error.message).toBe('DeepSeek balance: invalid JSON response')
    expect(error.message).not.toContain(KEY)
    expect(String(error.stack)).not.toContain(KEY)
  })

  it('throws a key-free error for a JSON body of the wrong shape', async () => {
    respond = (res) => { res.end(JSON.stringify({ key: KEY })) }
    const error = await errorOf(apiKeyFetcher({ baseURL, resolveKey: async () => KEY })(signal()))
    expect(error.message).toBe('DeepSeek balance: unexpected response shape')
    expect(error.message).not.toContain(KEY)
  })

  it('replaces transport errors that mention the key with a fixed message', async () => {
    const leaky: typeof fetch = async (_input, init) => {
      throw new TypeError(`connect failed: ${JSON.stringify(init?.headers)}`)
    }
    const error = await errorOf(apiKeyFetcher({ baseURL, resolveKey: async () => KEY, fetch: leaky })(signal()))
    expect(error.message).toBe('DeepSeek balance: request failed')
    expect(error.message).not.toContain(KEY)
    expect(error.cause).toBeUndefined()
  })

  it('reports a malformed baseURL as a configuration error, not a network failure', async () => {
    let called = false
    const spy: typeof fetch = async () => { called = true; return new Response('{}') }
    const error = await errorOf(apiKeyFetcher({ baseURL: 'not a url', resolveKey: async () => KEY, fetch: spy })(signal()))
    expect(error.message).toBe('DeepSeek balance: invalid baseURL')
    expect(error.message).not.toContain(KEY)
    expect(called).toBe(false)
  })

  it('cancels the body of a non-2xx response', async () => {
    let cancelled = false
    const body = new ReadableStream({ cancel() { cancelled = true } })
    const stub: typeof fetch = async () => new Response(body, { status: 503 })
    const error = await errorOf(apiKeyFetcher({ baseURL, resolveKey: async () => KEY, fetch: stub })(signal()))
    expect(error.message).toBe('DeepSeek balance: HTTP 503')
    expect(cancelled).toBe(true)
  })

  it('throws the signal reason, not the transport error, when aborted', async () => {
    const controller = new AbortController()
    const racing: typeof fetch = async (_input, init) => {
      controller.abort(new Error('timed out'))
      throw new TypeError(`transport said ${JSON.stringify(init?.headers)}`)
    }
    const error = await errorOf(apiKeyFetcher({ baseURL, resolveKey: async () => KEY, fetch: racing })(controller.signal))
    expect(error.message).toBe('timed out')
    expect(error.message).not.toContain(KEY)
  })

  it('surfaces an abort with its own reason', async () => {
    respond = () => { /* never answer */ }
    const controller = new AbortController()
    const pending = errorOf(apiKeyFetcher({ baseURL, resolveKey: async () => KEY })(controller.signal))
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort(new Error('timed out'))
    const error = await pending
    expect(error.message).toBe('timed out')
    expect(error.message).not.toContain(KEY)
  })

  it('throws "not configured" without a key and sends no request', async () => {
    const error = await errorOf(apiKeyFetcher({ baseURL, resolveKey: async () => undefined })(signal()))
    expect(error.message).toBe('DEEPSEEK_API_KEY not configured')
    expect(received.path).toBeUndefined()
  })

  it('treats an empty key as not configured', async () => {
    const error = await errorOf(apiKeyFetcher({ baseURL, resolveKey: async () => '' })(signal()))
    expect(error.message).toBe('DEEPSEEK_API_KEY not configured')
  })
})

describe('accountFetcher', () => {
  it('throws when signed out', async () => {
    const fetcher = accountFetcher({ getBalance: async () => null, version: '0.2.0-rc.2' })
    expect((await errorOf(fetcher(signal()))).message).toBe('DeepSeek account: signed out')
  })

  it('throws when the balance query failed', async () => {
    const fetcher = accountFetcher({ getBalance: async () => ({ status: 'failed' }), version: '0.2.0-rc.2' })
    expect((await errorOf(fetcher(signal()))).message).toBe('DeepSeek account: balance query failed')
  })

  it('returns wallets and passes the client metadata', async () => {
    const clients: unknown[] = []
    const fetcher = accountFetcher({
      version: '0.2.0-rc.2',
      getBalance: async (client) => {
        clients.push(client)
        return {
          status: 'ready',
          value: [{ currency: 'CNY', balance: '12.5' }],
          bonusWallets: [{ currency: 'CNY', balance: '1.5' }],
        }
      },
    })
    expect(await fetcher(signal())).toEqual([
      { kind: 'topup', money: { amount: '12.5', currency: 'CNY' } },
      { kind: 'granted', money: { amount: '1.5', currency: 'CNY' } },
      { kind: 'total', money: { amount: '14', currency: 'CNY' } },
    ])
    expect(clients).toEqual([
      { version: '0.2.0-rc.2', locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 },
    ])
  })
})
