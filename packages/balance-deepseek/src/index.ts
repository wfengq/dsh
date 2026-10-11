import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import type {} from 'dsh-tally-api'
import { accountFetcher, apiKeyFetcher } from './fetchers.js'

export * from './parse.js'
export * from './fetchers.js'

export const name = 'dsh-tally-balance-deepseek'

export const inject = ['tallyBalance']

export interface Config {
  /** Base URL of the DeepSeek API. */
  baseURL: string
  /** Name of the credential (environment variable) that holds the API key. */
  apiKeyRef: string
  /** Route id under which the API-key balance is registered. */
  officialRoute: string
  /** Route id under which the signed-in account balance is registered. */
  accountRoute: string
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  baseURL: Schema.string().default('https://api.deepseek.com').description('DeepSeek API 地址'),
  apiKeyRef: Schema.string().default('DEEPSEEK_API_KEY').description('保存 API key 的凭据名（环境变量名）'),
  officialRoute: Schema.string().default('deepseek-official').description('用 API key 查询余额时对应的路由 id'),
  accountRoute: Schema.string().default('deepseek-account').description('用登录账号查询余额时对应的路由 id'),
})

/** The official settings-account UI also reports a fixed dsh version. */
const DSH_VERSION = '0.2.0-rc.2'

export function apply(ctx: Context, config: Config) {
  ctx.inject(['credentials'], (c) => {
    c.effect(
      () => c.tallyBalance.register(
        config.officialRoute,
        apiKeyFetcher({
          baseURL: config.baseURL,
          resolveKey: async () => (await c.credentials.resolve(config.apiKeyRef as CredentialRef))?.value,
        }),
      ),
      'tally balance: ' + config.officialRoute,
    )
  })
  ctx.inject(['deepseekAccount'], (c) => {
    c.effect(
      () => c.tallyBalance.register(
        config.accountRoute,
        accountFetcher({
          getBalance: (client) => c.deepseekAccount.getBalance(client),
          version: DSH_VERSION,
        }),
      ),
      'tally balance: ' + config.accountRoute,
    )
  })
}
