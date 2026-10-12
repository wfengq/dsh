/** Problems of the status, grouped for the settings page: every unreadable session log becomes one line. */
import type { TallyStatusView } from 'dsh-tally-api'

export type ProblemRow =
  | { kind: 'sessions'; count: number; items: { sessionId: string; message: string }[] }
  | { kind: 'usage' | 'pricing' | 'budget'; message: string }

export function groupProblems(status: TallyStatusView): ProblemRow[] {
  const sessions: { sessionId: string; message: string }[] = []
  const rows: ProblemRow[] = []
  for (const error of status.usage.errors) {
    if (error.sessionId === undefined) rows.push({ kind: 'usage', message: error.message })
    else sessions.push({ sessionId: error.sessionId, message: error.message })
  }
  for (const message of status.pricingErrors) rows.push({ kind: 'pricing', message })
  for (const message of status.budgetErrors) rows.push({ kind: 'budget', message })
  return sessions.length === 0 ? rows : [{ kind: 'sessions', count: sessions.length, items: sessions }, ...rows]
}
