import { HoverCard } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { CatalogView, TallyEntry, TurnUsage, UsageGroup } from 'dsh-tally-api'
import type { Elements } from './elements.ts'
import { formatTokens, hitRate } from './format.ts'
import { costLabel, FORMAT_LOCALE, isWebUrl, type T } from './labels.ts'
import type { Snapshot } from './store.ts'
import './TurnCost.css'

/** What the registration hands the turn tail for one session. */
export interface TurnCostInjected {
  hooks: {
    elements: Snapshot<Elements>
    /** Changes whenever new entries were recorded; a turn whose entries were not there yet asks again. */
    today: Snapshot<UsageGroup | null>
    /** The store's `hello` count: prices or the ledger may have changed, so a shown turn asks again. */
    generation: Snapshot<number>
  }
  /** The `tally/turn` call; `null` when it failed. */
  loadTurn: (request: { sessionId: string; fromSeq: number; toSeq: number }) => Promise<TurnUsage | null>
  /** The price catalog, cached by the plugin per `hello` generation; `null` when unavailable. */
  catalog: () => Promise<CatalogView | null>
}

/** The owner share of `conversation.chat.turnTail` this element reads. */
interface TurnRange {
  turn: {
    readonly start: { readonly seq: number } | undefined
    readonly end: { readonly seq: number } | undefined
  }
  sessionId: string
}

export type TurnCostProps = TurnRange & InjectFace<TurnCostInjected> & { t: T }

/**
 * Cost of one finished turn at its tail, with token, cache and price details on hover. Renders
 * nothing for a turn that has not ended or has no entries.
 */
export function TurnCost({ turn, sessionId, useElements, useToday, useGeneration, loadTurn, catalog, t }: TurnCostProps): ReactNode {
  const enabled = useElements((e: Elements) => e.turnTail)
  const recorded = useToday((s: UsageGroup | null) => s)
  const generation = useGeneration((g: number) => g)
  /** Generation of the shown usage; a newer one refetches it. */
  const shownGeneration = useRef<number | undefined>(undefined)
  const fromSeq = turn.start?.seq
  const toSeq = turn.end?.seq
  const [usage, setUsage] = useState<TurnUsage | null>(null)
  const [sources, setSources] = useState<CatalogView | null>(null)
  const found = usage !== null && usage.attempts.length > 0

  useEffect(() => {
    if (!enabled || fromSeq === undefined || toSeq === undefined) return
    // A shown turn only asks again for a new generation; `recorded` re-asks while the entries have not arrived.
    if (found && shownGeneration.current === generation) return
    let live = true
    const asked = generation
    loadTurn({ sessionId, fromSeq, toSeq }).then(
      (next) => {
        if (!live || next === null) return
        shownGeneration.current = asked
        setUsage(next)
      },
      () => {},
    )
    return () => { live = false }
  }, [enabled, sessionId, fromSeq, toSeq, loadTurn, found, generation, found ? null : recorded])

  useEffect(() => {
    if (!found) return
    let live = true
    catalog().then((view) => { if (live) setSources(view) }, () => {})
    return () => { live = false }
  }, [found, catalog, generation])

  if (!enabled || fromSeq === undefined || toSeq === undefined || !found) return null
  const rate = hitRate(usage.total.tokens)
  const details = (
    <dl className="dsh-tally-turn-details">
      <dt>{t('turn.input')}</dt>
      <dd className="dsh-tally-num">{formatTokens(usage.total.tokens.input, FORMAT_LOCALE)}</dd>
      <dt>{t('turn.cacheRead')}</dt>
      <dd className="dsh-tally-num">{formatTokens(usage.total.tokens.cacheRead, FORMAT_LOCALE)}</dd>
      <dt>{t('turn.output')}</dt>
      <dd className="dsh-tally-num">{formatTokens(usage.total.tokens.output, FORMAT_LOCALE)}</dd>
      <dt>{t('turn.hitRate')}</dt>
      <dd className="dsh-tally-num">{rate === null ? '—' : `${Math.round(rate * 100)}%`}</dd>
      <dt>{t('turn.requests')}</dt>
      <dd className="dsh-tally-num" data-tally="requests">{usage.attempts.length}</dd>
      <dt>{t('turn.priceVersion')}</dt>
      <dd>{priceVersions(usage.attempts, sources)}</dd>
    </dl>
  )
  return (
    <div className="dsh-tally-turn">
      <HoverCard
        variant="compact"
        openDelayMs={200}
        anchor={(
          <span className="dsh-tally-turn-anchor" data-tally="turn" tabIndex={0}>
            <span className="dsh-tally-label">{t('turn.cost')}</span>
            <span className="dsh-tally-num">{costLabel(usage.total, t)}</span>
          </span>
        )}
        content={details}
      />
    </div>
  )
}

/** The distinct price versions of a turn, each linking to its catalog source when known. */
function priceVersions(attempts: readonly TallyEntry[], catalog: CatalogView | null): ReactNode {
  const seen = new Map<string, string | undefined>()
  for (const a of attempts) {
    if (a.priceVersion === null || seen.has(a.priceVersion)) continue
    const provider = catalog?.providers.find(p => p.id === a.provider)
    const model = provider?.models.find(m => m.priceVersion === a.priceVersion)
      ?? catalog?.providers.flatMap(p => p.models).find(m => m.priceVersion === a.priceVersion)
    seen.set(a.priceVersion, model?.source.url)
  }
  if (seen.size === 0) return '—'
  return [...seen].map(([version, url], i) => (
    <span key={version}>
      {i > 0 ? ', ' : null}
      {url !== undefined && isWebUrl(url)
        ? <a href={url} target="_blank" rel="noreferrer noopener" data-tally="price-source">{version}</a>
        : version}
    </span>
  ))
}
