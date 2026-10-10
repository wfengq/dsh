import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { foldEvent, initialFoldState, type BilledAttempt, type FoldState } from './attempt-fold.js'
import { normalizeUsage } from './normalize.js'
import { resolveRoot } from './root.js'
import type { StoredEntry, TallyStore } from './store.js'

/** The header fields the ledger needs: identity, sub-agent lineage and workspace. */
export type SessionHeaderLike = Pick<SessionHeader, 'id' | 'origin' | 'parentSession' | 'cwd'>

const ZERO_TOKENS = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } as const

/**
 * Turns session events into ledger entries, resuming per session from the stored cursor.
 *
 * `ingest` is synchronous and runs in one store transaction, so calls for the same session
 * never interleave and a crash leaves either all or none of one call's writes behind.
 */
export class Recorder {
  readonly #store: TallyStore
  readonly #onEntry: (e: StoredEntry) => void
  readonly #headers: (id: string) => SessionHeaderLike | undefined

  /**
   * @param onEntry - called once per newly inserted entry, after the transaction commits.
   * @param headers - header lookup used to walk a sub-agent's parents to its root session.
   */
  constructor(
    store: TallyStore,
    onEntry: (e: StoredEntry) => void,
    headers: (id: string) => SessionHeaderLike | undefined,
  ) {
    this.#store = store
    this.#onEntry = onEntry
    this.#headers = headers
  }

  /** Seq of the last event folded for the session, or `undefined` before the first ingest. */
  lastSeq(sessionId: string): number | undefined {
    return this.#store.getCursor(sessionId)?.lastSeq
  }

  /**
   * Fold the session's own (non-inherited) events with `seq` above the stored cursor and
   * record every settled attempt.
   *
   * `ownEvents` must be in seq order and contiguous from the cursor (or from the session's
   * first own event when there is no cursor yet); events at or below the cursor are skipped,
   * so passing the full own log again is always safe.
   * @returns the number of entries that were newly added.
   */
  ingest(sessionId: string, header: SessionHeaderLike, ownEvents: readonly SessionEvent[]): number {
    const added = this.#store.transaction(() => {
      const cursor = this.#store.getCursor(sessionId)
      const startSeq = cursor?.lastSeq ?? -1
      let lastSeq = startSeq
      let state = cursor === undefined ? initialFoldState() : JSON.parse(cursor.state) as FoldState
      let rootSessionId: string | undefined
      const inserted: StoredEntry[] = []
      for (const event of ownEvents) {
        if (event.seq <= lastSeq) continue
        const result = foldEvent(state, event)
        state = result.state
        lastSeq = event.seq
        for (const attempt of result.settled) {
          rootSessionId ??= resolveRoot(header, this.#headers)
          const entry = toEntry(sessionId, rootSessionId, header, attempt)
          if (this.#store.upsertEntry(entry)) inserted.push(entry)
        }
      }
      if (lastSeq !== startSeq) this.#store.setCursor(sessionId, { lastSeq, state: JSON.stringify(state) })
      return inserted
    })
    for (const entry of added) this.#onEntry(entry)
    return added.length
  }
}

function toEntry(sessionId: string, rootSessionId: string, header: SessionHeaderLike, a: BilledAttempt): StoredEntry {
  // An attempt that settled without any usage sample is recorded as unknown usage.
  const usage = a.usage === null ? { known: false, tokens: { ...ZERO_TOKENS } } : normalizeUsage(a.usage)
  return {
    id: `${sessionId}:${a.seq}`,
    sessionId,
    rootSessionId,
    workspaceId: header.cwd ?? null,
    at: a.at,
    route: a.route,
    model: a.model,
    tokens: usage.tokens,
    usageKnown: usage.known,
    deleted: false,
  }
}
