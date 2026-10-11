import type { AccountClientMetadata, AccountDetails } from '@deepseek-ai/dsh-deepseek-account'
import type { BalanceFetcher } from 'dsh-tally-api'
import { parseAccountBalance, parseApiBalance } from './parse.js'

export interface ApiKeyFetcherOptions {
  baseURL: string
  /** Resolved on every call so a changed credential applies without a restart. */
  resolveKey: () => Promise<string | undefined>
  /** Name of the credential, used in the "not configured" error. It is a name, never the key itself. */
  keyName?: string
  fetch?: typeof fetch
}

/**
 * Fetcher for `GET {baseURL}/user/balance` with an API key.
 *
 * Every error thrown from here carries a fixed message (the credential name at most): the key is only ever placed in the
 * request header and never reaches an error, log or snapshot. Errors raised by `fetch` or
 * `res.json()` are replaced rather than forwarded, because their text is not under our control.
 */
export function apiKeyFetcher(opts: ApiKeyFetcherOptions): BalanceFetcher {
  const fetch = opts.fetch ?? globalThis.fetch
  return async (signal) => {
    const key = await opts.resolveKey()
    if (!key) throw new Error(`${opts.keyName ?? 'DEEPSEEK_API_KEY'} not configured`)

    let url: URL
    try {
      url = new URL('/user/balance', opts.baseURL)
    } catch {
      throw new Error('DeepSeek balance: invalid baseURL')
    }

    let res: Response
    try {
      res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
        signal,
      })
    } catch {
      // An abort (timeout or shutdown) keeps its own reason so callers can tell it apart;
      // anything else is replaced, because its text is not under our control.
      if (signal.aborted) throw signal.reason
      throw new Error('DeepSeek balance: request failed')
    }
    if (!res.ok) {
      // Release the connection; the body is never read or reported.
      try { await res.body?.cancel() } catch { /* nothing to release */ }
      throw new Error('DeepSeek balance: HTTP ' + res.status)
    }

    let json: unknown
    try {
      json = await res.json()
    } catch {
      if (signal.aborted) throw signal.reason
      throw new Error('DeepSeek balance: invalid JSON response')
    }
    return parseApiBalance(json)
  }
}

export interface AccountFetcherOptions {
  getBalance: (client: AccountClientMetadata) => Promise<AccountDetails['balance'] | null>
  /** The dsh version reported to the account platform. */
  version: string
}

/** Fetcher backed by the official `deepseekAccount` service; it makes no request of its own. */
export function accountFetcher(opts: AccountFetcherOptions): BalanceFetcher {
  return async () => {
    const r = await opts.getBalance({
      version: opts.version,
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })
    if (r === null) throw new Error('DeepSeek account: signed out')
    if (r.status === 'failed') throw new Error('DeepSeek account: balance query failed')
    return parseAccountBalance(r)
  }
}
