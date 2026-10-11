/**
 * Browser-facing contract of the `tally` Remote namespace (`dsh-tally/remote`).
 *
 * dsh's Typert generator only runs inside the dsh repository, so this package writes the
 * contribution by hand, in the shape of the generated `typert.remote-client.js` files: strict
 * zod codecs the Client Remote validates against, plus the declaration merges that type
 * `ctx.remote.tally`. The Host validates requests with the same `schemas`.
 *
 * This module must stay browser-safe: it may import only zod and types.
 */
import { z } from 'zod'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { TallyStatusView } from 'dsh-tally-api'

const PACKAGE = 'dsh-tally'
const SERVICE = 'tallyRemote'
const NAMESPACE = 'tally'

const tallyStatus = z.object({
  backfill: z.object({ done: z.number(), total: z.number() }).nullable(),
  errors: z.array(z.object({ sessionId: z.string().optional(), message: z.string() })),
})

const statusView = z.object({
  usage: tallyStatus,
  catalogVersion: z.string(),
  pricingErrors: z.array(z.string()),
  budgetErrors: z.array(z.string()),
  balanceRoutes: z.array(z.string()),
}) satisfies z.ZodType<TallyStatusView>

/**
 * Request and result schema of every method. `request` describes the method's single `request`
 * parameter; it is `z.undefined()` for a method that takes none.
 */
export const schemas = {
  status: { request: z.undefined(), result: statusView },
}

/** Client signatures of the namespace; the declaration merges below are derived from it. */
export interface TallyRemoteApi {
  status: () => Promise<RemoteResult<TallyStatusView>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'tally/status': TallyRemoteApi['status']
  }
  interface TypertRemoteNamespaceMap {
    tally: TallyRemoteApi
  }
}

export const TALLY_REMOTE: TypertRemoteContribution = {
  package: PACKAGE,
  descriptors: [
    {
      id: `${PACKAGE}#${NAMESPACE}/status`,
      service: SERVICE,
      namespace: NAMESPACE,
      method: 'status',
      invocation: { kind: 'direct' },
      parameters: [],
      result: { mode: 'strict', typeSymbol: 'dsh-tally-api#TallyStatusView', create: () => schemas.status.result },
    },
  ],
}

export default TALLY_REMOTE
