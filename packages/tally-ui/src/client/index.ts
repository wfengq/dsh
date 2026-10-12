/**
 * Browser entry of dsh-tally-ui: mounts the `tally` Remote namespace, feeds the client store from
 * its reconnecting `watch` stream and registers the conversation elements (composer cost dock,
 * per-turn cost, session header total and the budget toast).
 */
import { makeOpenDashboard, type SidebarRightFace } from './open-dashboard.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CatalogView, TallyWatchFrame } from 'dsh-tally-api'
import { mountTallyRemote, type TallyRemoteApi } from 'dsh-tally/remote'
import { BudgetToast, type BudgetToastInjected } from './BudgetToast.tsx'
import { CostDock, type CostDockInjected } from './CostDock.tsx'
import { Dashboard, type DashboardInjected } from './dashboard/Dashboard.tsx'
import { tabDefinition, TAB_ID } from './dashboard/definition.ts'
import { elementsOf, type ElementsFormSnapshot } from './elements.ts'
import { en, NS, zh, type TallyLocaleKey } from './locales.ts'
import { Section, type SectionInjected } from './settings/Section.tsx'
import { SessionTotal, type SessionTotalInjected } from './SessionTotal.tsx'
import { createTallyStore } from './store.ts'
import { TurnCost, type TurnCostInjected } from './TurnCost.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    tally: TallyLocaleKey
  }
}

export const inject = ['remote', 'slots', 'locale', 'configForms']

/** Loader entry id of this plugin, which names its settings namespace. */
const ENTRY_ID = 'tally-ui'

const DOCK = 'conversation.composer.dock'
const TURN_TAIL = 'conversation.chat.turnTail'
const UTILITIES = 'conversation.session.header.utilities'
const OVERLAY = 'shell.overlay'
const SIDEBAR_TAB = 'sidebar.right.pane.tab'
const SETTINGS_SECTION = 'settings.section'

/** The value of a call, or `null` when it was refused or the transport failed. */
async function valueOf<T>(call: Promise<RemoteResult<T>>): Promise<T | null> {
  try {
    const result = await call
    return result.ok ? result.value : null
  } catch {
    return null
  }
}

/** Unwraps the reconnecting stream, accepting each generation's opening frame once the store has it. */
async function* framesOf(stream: AsyncIterable<{ value: TallyWatchFrame; accept(): void }>): AsyncGenerator<TallyWatchFrame> {
  for await (const item of stream) {
    yield item.value
    item.accept()
  }
}

export async function apply(ctx: Context): Promise<void> {
  // `$mount` owns its effect on this fiber: unloading the plugin withdraws the namespace. Another
  // client plugin may have mounted it first; the helper treats that as success.
  await mountTallyRemote(ctx)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tally-ui: dictionaries')
  const elements = elementsOf(ctx.configForms.get<ElementsFormSnapshot['value']>(ENTRY_ID))

  ctx.inject(['remote.tally'], (scope) => {
    const remote: TallyRemoteApi = scope.remote.tally
    const store = createTallyStore(remote, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    const stream = scope.remote.$stream<TallyWatchFrame>({
      name: 'tally',
      open: (signal: AbortSignal) => scope.remote.tally.watch(signal),
      ended: () => new Error('tally stream ended'),
    })
    const abort = new AbortController()
    store.start(abort.signal, framesOf(stream))
    scope.effect(() => () => {
      abort.abort()
      return stream.dispose()
    }, 'dsh-tally-ui: watch stream')

    // The catalog is cached per `hello` generation: a `hello` may follow a change of the price overrides.
    let catalog: { generation: number; pending: Promise<CatalogView | null> } | undefined
    const loadCatalog = () => {
      const generation = store.generation.getSnapshot()
      if (catalog === undefined || catalog.generation !== generation) catalog = { generation, pending: valueOf(remote.catalog()) }
      const entry = catalog
      // A failed load is retried by the next caller.
      void entry.pending.then((view) => { if (view === null && catalog === entry) catalog = undefined })
      return entry.pending
    }
    const band: CostDockInjected['band'] = request => valueOf(remote.band(request))
    const loadTurn: TurnCostInjected['loadTurn'] = request => valueOf(remote.turn(request))
    const refreshBalance = (route: string) => store.refreshBalance(route)
    const dismissAlert: BudgetToastInjected['dismissAlert'] = alert => store.dismissAlert(alert)
    const openDashboard = makeOpenDashboard(
      () => scope.get('sidebarRight') as SidebarRightFace | undefined,
      () => elements.getSnapshot().sidebarTab,
    )
    const loadModels: SessionTotalInjected['loadModels'] = sessionId =>
      valueOf(remote.query({ from: 0, to: Date.now() + 1, groupBy: 'model', filter: { rootSessionId: sessionId } }))

    scope.slots.inject(DOCK, () => scope.slots.register({
      name: DOCK,
      id: 'tally.dock',
      order: 0,
      locale: NS,
      inject: (sessionId: string): CostDockInjected => ({
        hooks: {
          elements,
          session: store.session(sessionId),
          today: store.today,
          month: store.month,
          budgets: store.budgets,
          budgetSpend: store.budgetSpend,
          balances: store.balances,
          status: store.status,
        },
        refreshBalance,
        band,
        openDashboard,
      }),
    }, CostDock))

    scope.slots.inject(TURN_TAIL, () => scope.slots.register({
      name: TURN_TAIL,
      id: 'tally.turn',
      order: 50,
      locale: NS,
      inject: (): TurnCostInjected => ({ hooks: { elements, today: store.today, generation: store.generation }, loadTurn, catalog: loadCatalog }),
    }, TurnCost))

    scope.slots.inject(UTILITIES, () => scope.slots.register({
      name: UTILITIES,
      id: 'tally.total',
      order: -10,
      locale: NS,
      inject: (sessionId: string): SessionTotalInjected => ({ hooks: { elements, session: store.session(sessionId) }, sessionId, loadModels, openDashboard }),
    }, SessionTotal))

    scope.slots.inject(OVERLAY, () => scope.slots.register({
      name: OVERLAY,
      id: 'tally.budget',
      locale: NS,
      inject: (): BudgetToastInjected => ({ hooks: { elements, alerts: store.alerts, budgets: store.budgets }, dismissAlert, openDashboard }),
    }, BudgetToast))

    scope.slots.inject(SETTINGS_SECTION, () => {
      const t = scope.locale.bind(NS)
      const face: SectionInjected = {
        remote,
        overridesForm: scope.configForms.get<never>('tally'),
        elementsForm: scope.configForms.get<never>(ENTRY_ID),
        status: store.status,
        generation: store.generation,
        budgetSpend: store.budgetSpend,
      }
      return scope.slots.register({
        name: SETTINGS_SECTION,
        id: 'tally',
        order: 50,
        label: () => t('settings.nav'),
        locale: NS,
        inject: (): SectionInjected => face,
      }, Section)
    })

    // The dashboard tab exists only while `elements.sidebarTab` is on: the switch registers and withdraws it.
    // It needs the right sidebar's registry; a host without it keeps every other element.
    scope.inject(['sidebarRightTabs'], tabScope => tabScope.slots.inject(SIDEBAR_TAB, () => {
      const t = tabScope.locale.bind(NS)
      const dashboard: DashboardInjected = {
        remote,
        generation: store.generation,
        recorded: store.recorded,
        today: store.today,
        month: store.month,
        budgets: store.budgets,
        budgetSpend: store.budgetSpend,
      }
      let withdraw: (() => void) | undefined
      const sync = () => {
        const wanted = elements.getSnapshot().sidebarTab
        if (wanted && withdraw === undefined) {
          const unregisterType = tabScope.sidebarRightTabs.register(tabDefinition(t))
          const unregisterBody = tabScope.slots.register({
            name: SIDEBAR_TAB,
            key: TAB_ID,
            locale: NS,
            inject: (): DashboardInjected => dashboard,
          }, Dashboard)
          withdraw = () => { unregisterBody(); unregisterType() }
        } else if (!wanted && withdraw !== undefined) {
          withdraw()
          withdraw = undefined
        }
      }
      sync()
      const unsubscribe = elements.subscribe(sync)
      return () => { unsubscribe(); withdraw?.(); withdraw = undefined }
    }))
  })
}
