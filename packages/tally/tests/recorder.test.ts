import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Recorder, type SessionHeaderLike } from '../src/recorder.js'
import { TallyStore, type StoredEntry } from '../src/store.js'
import {
  attempt, header, message, retry, retryStarted, seqd, stepEnd, stepStart, T0, turnEnd, turnStart, U1, U2,
} from './fixtures/events.ts'

let dir: string
const stores: TallyStore[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-tally-recorder-'))
})

afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Entries sorted by id, since store reads come back in no particular order. */
function byId(entries: StoredEntry[]): StoredEntry[] {
  return [...entries].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
}

function open(name = 'tally.v1.sqlite'): TallyStore {
  const store = TallyStore.open(join(dir, name))
  stores.push(store)
  return store
}

const ROOT = { id: 'root', cwd: '/work' } as SessionHeaderLike
const CHILD = { id: 'child', origin: 'subagent', parentSession: 'root', cwd: '/work' } as SessionHeaderLike
const headers = new Map<string, SessionHeaderLike>([[ROOT.id, ROOT], [CHILD.id, CHILD]])
const lookup = (id: string) => headers.get(id)

function recorder(store: TallyStore) {
  const seen: StoredEntry[] = []
  return { seen, rec: new Recorder(store, e => seen.push(e), lookup) }
}

// Two turns: turn 1 retries once (two billed attempts), turn 2 has one step.
const log: SessionEvent[] = seqd([
  turnStart(1), header('deepseek-official', 'deepseek-flash'), stepStart(1, 1), attempt(1, 1, U2), retry(1, 1),
  retryStarted(1, 1, 1), message(1, 1, U1), stepEnd(1, 1), turnEnd(1),
  turnStart(2), header('deepseek-official', 'deepseek-flash'), stepStart(2, 1), message(2, 1, U1), stepEnd(2, 1),
  turnEnd(2),
])

describe('Recorder', () => {
  it('ingests incrementally and reports only new entries', () => {
    const store = open()
    const { seen, rec } = recorder(store)
    const firstPart = log.slice(0, 12) // up to step/start of turn 2
    expect(rec.ingest('root', ROOT, firstPart)).toBe(2)
    expect(seen.map(e => e.id)).toEqual(['root:3', 'root:6'])

    const added = log.slice(0, 14) // two more events: the turn-2 message settles one attempt
    expect(rec.ingest('root', ROOT, added)).toBe(1)
    expect(seen.map(e => e.id)).toEqual(['root:3', 'root:6', 'root:12'])

    // Replaying the same events adds nothing.
    expect(rec.ingest('root', ROOT, log.slice(0, 14))).toBe(0)
    expect(seen).toHaveLength(3)
    expect(store.getCursor('root')?.lastSeq).toBe(13)
  })

  it('builds stored entries from the settled attempts', () => {
    const store = open()
    const { seen, rec } = recorder(store)
    rec.ingest('root', ROOT, log)
    expect(seen[0]).toEqual({
      id: 'root:3',
      sessionId: 'root',
      rootSessionId: 'root',
      workspaceId: '/work',
      at: T0 + 2000,
      route: 'deepseek-official',
      model: 'deepseek-flash',
      tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 },
      usageKnown: true,
      deleted: false,
    })
    expect(byId(store.entries({ from: 0, to: Number.MAX_SAFE_INTEGER }))).toEqual(byId(seen))
  })

  it('event-by-event ingest equals one-shot ingest', () => {
    const a = open('a.sqlite')
    const b = open('b.sqlite')
    const ra = recorder(a)
    const rb = recorder(b)
    ra.rec.ingest('root', ROOT, log)
    let total = 0
    for (let i = 1; i <= log.length; i++) total += rb.rec.ingest('root', ROOT, log.slice(0, i))
    expect(total).toBe(3)
    const all = { from: 0, to: Number.MAX_SAFE_INTEGER }
    expect(byId(b.entries(all))).toEqual(byId(a.entries(all)))
    expect(b.getCursor('root')).toEqual(a.getCursor('root'))
  })

  it('resumes the fold from the stored cursor when given only the new events', () => {
    const a = open('a.sqlite')
    const b = open('b.sqlite')
    recorder(a).rec.ingest('root', ROOT, log)
    const rb = recorder(b).rec
    for (const event of log) rb.ingest('root', ROOT, [event])
    const all = { from: 0, to: Number.MAX_SAFE_INTEGER }
    expect(byId(b.entries(all))).toEqual(byId(a.entries(all)))
  })

  it('attributes sub-agent entries to the root session', () => {
    const store = open()
    const { seen, rec } = recorder(store)
    expect(rec.ingest('child', CHILD, log)).toBe(3)
    expect(seen.every(e => e.sessionId === 'child' && e.rootSessionId === 'root')).toBe(true)
  })

  it('records an attempt settled without usage as unknown usage with zero tokens', () => {
    const store = open()
    const { seen, rec } = recorder(store)
    const noUsage = seqd([
      turnStart(1), header('deepseek-official', 'deepseek-flash'), stepStart(1, 1), message(1, 1, undefined),
      stepEnd(1, 1), turnEnd(1),
    ])
    expect(rec.ingest('root', ROOT, noUsage)).toBe(1)
    expect(seen[0]).toMatchObject({
      usageKnown: false,
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    })
  })

  it('stores a null workspace when the header has no cwd', () => {
    const store = open()
    const { seen, rec } = recorder(store)
    rec.ingest('bare', { id: 'bare' } as SessionHeaderLike, log)
    expect(seen[0]?.workspaceId).toBeNull()
  })

  it('reports whether a session was folded to a turn boundary', () => {
    const store = open()
    const { rec } = recorder(store)
    expect(rec.isSettled('root')).toBe(false) // no cursor yet
    rec.ingest('root', ROOT, log.slice(0, 12)) // ends right after step/start: attempt open
    expect(rec.isSettled('root')).toBe(false)
    rec.ingest('root', ROOT, log.slice(0, 13)) // message settled, step not ended yet
    expect(rec.isSettled('root')).toBe(false)
    rec.ingest('root', ROOT, log.slice(0, 14)) // step ended, but the turn is still open
    expect(rec.isSettled('root')).toBe(false)
    rec.ingest('root', ROOT, log) // through turn/end
    expect(rec.isSettled('root')).toBe(true)
  })

  it('records without notifying when asked to', () => {
    const store = open()
    const { seen, rec } = recorder(store)
    expect(rec.ingest('root', ROOT, log, { notify: false })).toBe(3)
    expect(seen).toHaveLength(0)
    expect(store.entries({ from: 0, to: Number.MAX_SAFE_INTEGER })).toHaveLength(3)
  })

  it('rolls back entries and cursor when a write fails', () => {
    const store = open()
    const { seen, rec } = recorder(store)
    const original = store.setCursor.bind(store)
    store.setCursor = () => { throw new Error('disk full') }
    expect(() => rec.ingest('root', ROOT, log)).toThrow('disk full')
    expect(seen).toHaveLength(0)
    expect(store.entries({ from: 0, to: Number.MAX_SAFE_INTEGER })).toHaveLength(0)
    store.setCursor = original
    expect(rec.ingest('root', ROOT, log)).toBe(3)
  })
})
