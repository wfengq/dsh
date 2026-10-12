import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, type ReactNode } from 'react'
import type { TallyStatusView } from 'dsh-tally-api'
import type { T } from '../labels.ts'
import type { Snapshot } from '../store.ts'
import { SettingsCard } from './Card.tsx'
import { useSnapshot } from './form.ts'
import { groupProblems, type ProblemRow } from './problems.ts'

const SOURCE = { usage: 'settings.problem.usage', pricing: 'settings.problem.pricing', budget: 'settings.problem.budget' } as const

function SessionsLine({ row, t }: { row: Extract<ProblemRow, { kind: 'sessions' }>; t: T }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className="dsh-tally-row dsh-tally-problem" data-tally="problem">
      <DisclosureRow
        icon={null}
        title={t('settings.problem.sessions', { count: row.count })}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => { setOpen(o => !o) }}
        className="dsh-tally-disclosure"
      >
        <ul className="dsh-tally-problem-list">
          {row.items.map((item, i) => <li key={`${item.sessionId}:${i}`}>{`${item.sessionId}：${item.message}`}</li>)}
        </ul>
      </DisclosureRow>
    </div>
  )
}

/**
 * Problems the Host reports in its status: unreadable session logs (merged into one expandable line),
 * ledger errors, unusable price overrides and budget file errors. A ledger error comes with the hint that
 * the ledger can be rebuilt from the logs. Renders nothing while there is no problem.
 */
export function Problems({ status, t }: { status: Snapshot<TallyStatusView | null>; t: T }): ReactNode {
  const view = useSnapshot(status)
  if (view === null) return null
  const rows = groupProblems(view)
  if (rows.length === 0) return null
  const ledger = rows.some(r => r.kind === 'usage')
  return (
    <SettingsCard title={t('settings.problems')} tally="problems">
      {rows.map((row, i) => row.kind === 'sessions'
        ? <SessionsLine key="sessions" row={row} t={t} />
        : (
            <div key={`${row.kind}-${i}`} className="dsh-tally-row dsh-tally-problem dsh-tally-row-warn" data-tally="problem">
              {t('settings.problem.item', { source: t(SOURCE[row.kind]), message: row.message })}
            </div>
          ))}
      {ledger ? <div className="dsh-tally-row dsh-tally-row-muted" data-tally="rebuild-hint">{t('settings.problem.rebuildHint')}</div> : null}
    </SettingsCard>
  )
}
