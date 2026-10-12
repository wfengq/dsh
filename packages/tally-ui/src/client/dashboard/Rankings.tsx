import { Button, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { UsageGroup } from 'dsh-tally-api'
import { costLabel, type T } from '../labels.ts'
import { compareDecimal } from './decimal.ts'
import './dashboard.css'

export type RankingKind = 'session' | 'model' | 'workspace'
const TOP = 10

/** Share of the largest group, for the bar behind each row: CNY first, then USD, then requests. */
function share(group: UsageGroup, first: UsageGroup | undefined): number {
  if (first === undefined) return 0
  for (const currency of ['CNY', 'USD'] as const) {
    const top = first.cost.find(m => m.currency === currency)?.amount
    if (top === undefined || compareDecimal(top, '0') <= 0) continue
    const mine = group.cost.find(m => m.currency === currency)?.amount ?? '0'
    return Math.max(0, Math.min(1, Number(mine) / Number(top)))
  }
  return first.requestCount === 0 ? 0 : group.requestCount / first.requestCount
}

/** One ranking at a time (sessions, models or workspaces), top 10 until "show all"; the focused session is highlighted. */
export function Rankings({ models, workspaces, sessions, focusSession, t }: {
  models: readonly UsageGroup[]
  workspaces: readonly UsageGroup[]
  sessions: readonly UsageGroup[]
  /** Session the page was opened on: its ranking is selected and its row highlighted. */
  focusSession?: string | undefined
  t: T
}): ReactNode {
  const [kind, setKind] = useState<RankingKind>('session')
  const [all, setAll] = useState(false)
  // The focus is applied once per opening: later refreshes (a new `sessions` array after every turn)
  // keep whatever ranking the user picked. A focused session that only shows up later, past the top
  // 10, still expands the list, but a refresh never collapses it.
  const applied = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (focusSession === undefined) return
    if (applied.current !== focusSession) {
      applied.current = focusSession
      setKind('session')
    }
    if (sessions.findIndex(g => g.key === focusSession) >= TOP) setAll(true)
  }, [focusSession, sessions])

  const rows = kind === 'session' ? sessions : kind === 'model' ? models : workspaces
  const shown = all ? rows : rows.slice(0, TOP)
  const name = (g: UsageGroup): ReactNode => {
    const text = <span className="dsh-tally-ellipsis">{kind === 'workspace' && g.key === '' ? t('tab.unknownWorkspace') : g.key}</span>
    if (kind === 'session' && g.deletedCount !== undefined && g.deletedCount > 0) {
      return <>{text}<Tag>{t('tab.deleted', { count: g.deletedCount })}</Tag></>
    }
    return text
  }
  return (
    <section className="dsh-tally-card-group" data-tally="rankings">
      <div className="dsh-tally-card-head">
        <h3 className="dsh-tally-card-title">{t('tab.rankings')}</h3>
        <SegmentedControl
          id="dsh-tally-ranking"
          label={t('tab.rankings')}
          value={kind}
          options={[{ value: 'session', label: t('tab.bySession') }, { value: 'model', label: t('tab.byModel') }, { value: 'workspace', label: t('tab.byWorkspace') }]}
          onChange={(next) => { setKind(next); setAll(false) }}
        />
      </div>
      <div className="dsh-tally-card" data-tally={`ranking-${kind}`}>
        {rows.length === 0 ? <p className="dsh-tally-row-muted dsh-tally-pad">{t('tab.noRows')}</p> : null}
        <ol className="dsh-tally-ranking">
          {shown.map(group => (
            <li
              key={group.key}
              className="dsh-tally-rank"
              data-tally="rank-row"
              data-current={kind === 'session' && group.key === focusSession ? 'true' : undefined}
              style={{ '--dsh-tally-share': String(share(group, rows[0])) } as CSSProperties}
            >
              <span className="dsh-tally-row-name" title={group.key}>{name(group)}</span>
              <span className="dsh-tally-num">{costLabel(group, t)}</span>
            </li>
          ))}
        </ol>
        {rows.length > TOP && !all
          ? <div className="dsh-tally-card-footer"><Button variant="ghost" size="sm" onClick={() => { setAll(true) }}>{t('tab.showAll')}</Button></div>
          : null}
      </div>
    </section>
  )
}
