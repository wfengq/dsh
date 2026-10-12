import { isDeepStrictEqual } from 'node:util'
import { interruptedTurnClosers, type SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Drop the synthetic interrupted-turn closers that a cold `sessionQuery.readSession` appends
 * after a log whose tail turn is still open.
 *
 * Those closers occupy seqs `N+1..N+k` that the session's writer (possibly another process)
 * may still fill with the real `assistant/message`, `step/end` and `turn/end`; recording them
 * would move the cursor past those seqs and lose the real attempt for good.
 *
 * The suffix is recognised by recomputing `interruptedTurnClosers` on each candidate prefix:
 * closers are `tool/result*`, an optional `step/end`, then a `turn/end` with reason
 * `interrupted`, so only a handful of splits are tried. Persisted closers that happen to be
 * identical are stripped too; they settle no attempt, so nothing billable is lost and they
 * are folded once later events follow them.
 */
export function withoutInterruptedClosers(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const last = events.at(-1)
  if (last?.type !== 'turn/end' || (last as SessionEvent<'turn/end'>).data.reason.kind !== 'interrupted') return events
  let longest = 1
  while (longest < events.length && ['step/end', 'tool/result'].includes(events[events.length - longest - 1]!.type)) longest++
  // Longest first: a shorter suffix can also match, because a prefix that already holds the
  // synthetic tool results and step/end gets just the synthetic turn/end as its closers.
  for (let k = longest; k >= 1; k--) {
    const prefix = events.slice(0, events.length - k)
    if (isDeepStrictEqual(interruptedTurnClosers(prefix), events.slice(events.length - k))) return prefix
  }
  return events
}
