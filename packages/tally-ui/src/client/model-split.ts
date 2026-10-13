import type { UsageQuery } from 'dsh-tally-api'

/** The Remote API refuses ranges over 400 days; a session's split looks back a day less than that. */
const SPAN_MS = 399 * 86_400_000

/** The header total's split of one session (subagents included) by model, over the longest range allowed. */
export function modelSplitQuery(sessionId: string, now: number): UsageQuery {
  return { from: now - SPAN_MS, to: now + 1, groupBy: 'model', filter: { rootSessionId: sessionId } }
}
