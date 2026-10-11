import type { ReactNode } from 'react'
import type { UsageGroup } from 'dsh-tally-api'
import { costLabel, type T } from '../labels.ts'
import './dashboard.css'

/** Top models, workspaces and sessions by cost. */
export function Rankings({ models, workspaces, sessions, t }: {
  models: readonly UsageGroup[]
  workspaces: readonly UsageGroup[]
  sessions: readonly UsageGroup[]
  t: T
}): ReactNode {
  return (
    <>
      <RankingList kind="model" title={t('tab.byModel')} rows={models} name={g => g.key} t={t} />
      <RankingList kind="workspace" title={t('tab.byWorkspace')} rows={workspaces} name={g => (g.key === '' ? t('tab.unknownWorkspace') : g.key)} t={t} />
      <RankingList
        kind="session"
        title={t('tab.bySession')}
        rows={sessions}
        name={g => (
          <>
            {g.key}
            {g.deletedCount !== undefined && g.deletedCount > 0 ? <span className="dsh-tally-badge">{t('tab.deleted', { count: g.deletedCount })}</span> : null}
          </>
        )}
        t={t}
      />
    </>
  )
}

function RankingList({ title, rows, name, kind, t }: { title: string; rows: readonly UsageGroup[]; name: (g: UsageGroup) => ReactNode; kind: string; t: T }): ReactNode {
  if (rows.length === 0) return null
  return (
    <section className="dsh-tally-section" data-tally={`ranking-${kind}`}>
      <h3>{title}</h3>
      <ol className="dsh-tally-ranking">
        {rows.map(group => (
          <li key={group.key} className="dsh-tally-row" data-tally="rank-row">
            <span className="dsh-tally-row-name" title={group.key}>{name(group)}</span>
            <span className="dsh-tally-num">{costLabel(group, t)}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
