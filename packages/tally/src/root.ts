import type { SessionHeader } from '@deepseek-ai/dsh-session'

type RootHeader = Pick<SessionHeader, 'id' | 'origin' | 'parentSession'>

/**
 * Resolves the root session a header's cost rolls up to.
 *
 * Only subagent sessions climb to their parent; a fork (any other origin) is its own
 * root. The walk stops at the last id the lookup could find when a parent is missing,
 * and on a cycle it returns the id just before the cycle was entered (the starting id
 * when the start itself is on the cycle), so it always terminates.
 */
export function resolveRoot(header: RootHeader, lookup: (id: string) => RootHeader | undefined): string {
  const path: string[] = []
  let current = header
  for (;;) {
    path.push(current.id)
    if (current.origin !== 'subagent' || current.parentSession === undefined) return current.id
    const parentId: string = current.parentSession
    const seenAt = path.indexOf(parentId)
    if (seenAt !== -1) return path[Math.max(seenAt - 1, 0)]!
    const parent = lookup(parentId)
    if (parent === undefined) return current.id
    current = parent
  }
}
