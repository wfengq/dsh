/** Browser entry of dsh-tally-ui: mounts the `tally` Remote namespace and the session header dot. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import TALLY_REMOTE from 'dsh-tally/remote'
import { en, NS, zh, type TallyLocaleKey } from './locales.ts'
import { StatusDot, type StatusDotInjected } from './StatusDot.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    tally: TallyLocaleKey
  }
}

export const inject = ['remote', 'slots', 'locale']

const UTILITIES = 'conversation.session.header.utilities'

export async function apply(ctx: Context): Promise<void> {
  // `$mount` owns its effect on this fiber: unloading the plugin withdraws the namespace.
  await ctx.remote.$mount(TALLY_REMOTE)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tally-ui: dictionaries')
  ctx.inject(['remote.tally'], (scope) => {
    const injected: StatusDotInjected = { status: () => scope.remote.tally.status() }
    scope.slots.inject(UTILITIES, () => scope.slots.register({
      name: UTILITIES,
      id: 'tally-status',
      order: -10,
      locale: NS,
      inject: () => injected,
    }, StatusDot))
  })
}
