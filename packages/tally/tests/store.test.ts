import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TallyStore, type StoredEntry } from '../src/store.js'

let dir: string
let path: string
let store: TallyStore | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-tally-store-'))
  path = join(dir, 'tally.v1.sqlite')
})

afterEach(() => {
  store?.close()
  store = undefined
  rmSync(dir, { recursive: true, force: true })
})

function entry(over: Partial<StoredEntry> = {}): StoredEntry {
  return {
    id: 's1:1',
    sessionId: 's1',
    rootSessionId: 'root',
    workspaceId: '/work',
    at: 1000,
    route: 'deepseek-official',
    model: 'deepseek-flash',
    tokens: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50 },
    usageKnown: true,
    deleted: false,
    ...over,
  }
}

describe('TallyStore', () => {
  it('creates missing parent directories', () => {
    const nested = join(dir, 'a', 'b', 'tally.v1.sqlite')
    store = TallyStore.open(nested)
    expect(existsSync(nested)).toBe(true)
  })

  it('inserts once per id', () => {
    store = TallyStore.open(path)
    expect(store.upsertEntry(entry())).toBe(true)
    expect(store.upsertEntry(entry({ at: 2000 }))).toBe(false)
    const rows = store.entries({ from: 0, to: 10_000 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(entry())
  })

  it('round-trips reasoning tokens, null workspace and unknown usage', () => {
    store = TallyStore.open(path)
    store.upsertEntry(entry({
      id: 's1:2',
      workspaceId: null,
      usageKnown: false,
      tokens: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 5 },
    }))
    store.upsertEntry(entry({ id: 's1:3' }))
    const rows = store.entries({ from: 0, to: 10_000 })
    expect(rows.find(r => r.id === 's1:2')).toEqual(entry({
      id: 's1:2',
      workspaceId: null,
      usageKnown: false,
      tokens: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 5 },
    }))
    expect(rows.find(r => r.id === 's1:3')!.tokens).not.toHaveProperty('reasoning')
  })

  it('treats the time range as half-open [from, to)', () => {
    store = TallyStore.open(path)
    store.upsertEntry(entry({ id: 's1:1', at: 100 }))
    store.upsertEntry(entry({ id: 's1:2', at: 200 }))
    store.upsertEntry(entry({ id: 's1:3', at: 300 }))
    expect(store.entries({ from: 100, to: 300 }).map(e => e.id)).toEqual(['s1:1', 's1:2'])
  })

  it('filters by route, model, root session and session ids', () => {
    store = TallyStore.open(path)
    store.upsertEntry(entry({ id: 's1:1', at: 1 }))
    store.upsertEntry(entry({ id: 's2:1', sessionId: 's2', rootSessionId: 'other', route: 'r2', model: 'm2', at: 2 }))
    store.upsertEntry(entry({ id: 's3:1', sessionId: 's3', at: 3 }))
    const range = { from: 0, to: 10 }
    expect(store.entries({ ...range, route: 'r2' }).map(e => e.id)).toEqual(['s2:1'])
    expect(store.entries({ ...range, model: 'm2' }).map(e => e.id)).toEqual(['s2:1'])
    expect(store.entries({ ...range, rootSessionId: 'root' }).map(e => e.id)).toEqual(['s1:1', 's3:1'])
    expect(store.entries({ ...range, sessionIds: ['s1', 's2'] }).map(e => e.id)).toEqual(['s1:1', 's2:1'])
    expect(store.entries({ ...range, sessionIds: [] })).toEqual([])
  })

  it('clears all tables when user_version differs', () => {
    store = TallyStore.open(path)
    store.upsertEntry(entry())
    store.setCursor('s1', { lastSeq: 3, state: '{}' })
    store.close()
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version = 99')
    raw.close()
    store = TallyStore.open(path)
    expect(store.entries({ from: 0, to: 10_000 })).toEqual([])
    expect(store.getCursor('s1')).toBeUndefined()
  })

  it('keeps data across reopen at the current version', () => {
    store = TallyStore.open(path)
    store.upsertEntry(entry())
    store.close()
    store = TallyStore.open(path)
    expect(store.entries({ from: 0, to: 10_000 })).toHaveLength(1)
  })

  it('reads back cursors', () => {
    store = TallyStore.open(path)
    expect(store.getCursor('s1')).toBeUndefined()
    store.setCursor('s1', { lastSeq: 7, state: 'abc' })
    expect(store.getCursor('s1')).toEqual({ lastSeq: 7, state: 'abc' })
    store.setCursor('s1', { lastSeq: 9, state: 'def' })
    expect(store.getCursor('s1')).toEqual({ lastSeq: 9, state: 'def' })
  })

  it('marks every entry of a session deleted but keeps them listed', () => {
    store = TallyStore.open(path)
    store.upsertEntry(entry({ id: 's1:1' }))
    store.upsertEntry(entry({ id: 's1:2' }))
    store.upsertEntry(entry({ id: 's2:1', sessionId: 's2' }))
    store.markSessionDeleted('s1')
    const byId = Object.fromEntries(store.entries({ from: 0, to: 10_000 }).map(e => [e.id, e.deleted]))
    expect(byId).toEqual({ 's1:1': true, 's1:2': true, 's2:1': false })
  })

  it('reset empties entries and cursors', () => {
    store = TallyStore.open(path)
    store.upsertEntry(entry())
    store.setCursor('s1', { lastSeq: 1, state: '' })
    store.reset()
    expect(store.entries({ from: 0, to: 10_000 })).toEqual([])
    expect(store.getCursor('s1')).toBeUndefined()
    expect(store.upsertEntry(entry())).toBe(true)
  })

  it('moves a non-database file aside and starts empty', () => {
    writeFileSync(path, Buffer.from('not a database'))
    store = TallyStore.open(path)
    expect(store.entries({ from: 0, to: 10_000 })).toEqual([])
    expect(store.upsertEntry(entry())).toBe(true)
    const aside = readdirSync(dir).filter(f => f.startsWith('tally.v1.sqlite.corrupt-'))
    expect(aside).toHaveLength(1)
  })

  describe('transaction', () => {
    it('commits all writes on success and returns the result', () => {
      store = TallyStore.open(path)
      const out = store.transaction(() => {
        store!.upsertEntry(entry({ id: 's1:1' }))
        store!.upsertEntry(entry({ id: 's1:2' }))
        store!.setCursor('s1', { lastSeq: 2, state: 'x' })
        return 'ok'
      })
      expect(out).toBe('ok')
      expect(store.entries({ from: 0, to: 10_000 })).toHaveLength(2)
      expect(store.getCursor('s1')).toEqual({ lastSeq: 2, state: 'x' })
    })

    it('rolls back everything and rethrows when fn throws', () => {
      store = TallyStore.open(path)
      expect(() => store!.transaction(() => {
        store!.upsertEntry(entry({ id: 's1:1' }))
        store!.upsertEntry(entry({ id: 's1:2' }))
        throw new Error('boom')
      })).toThrow('boom')
      expect(store.entries({ from: 0, to: 10_000 })).toEqual([])
      // The store stays usable after a rollback.
      expect(store.upsertEntry(entry())).toBe(true)
    })

    it('runs nested calls inline inside the outer transaction', () => {
      store = TallyStore.open(path)
      store.transaction(() => {
        store!.upsertEntry(entry({ id: 's1:1' }))
        store!.transaction(() => store!.upsertEntry(entry({ id: 's1:2' })))
      })
      expect(store.entries({ from: 0, to: 10_000 })).toHaveLength(2)
      expect(() => store!.transaction(() => {
        store!.upsertEntry(entry({ id: 's1:3' }))
        store!.transaction(() => { throw new Error('inner') })
      })).toThrow('inner')
      expect(store.entries({ from: 0, to: 10_000 })).toHaveLength(2)
    })
  })

  it('throws on constraint violations instead of reporting a duplicate', () => {
    store = TallyStore.open(path)
    expect(() => store!.upsertEntry(entry({ at: Number.NaN }))).toThrow()
    expect(store.entries({ from: 0, to: 10_000 })).toEqual([])
  })

  it('rebuilds missing tables at the current user_version', () => {
    store = TallyStore.open(path)
    store.upsertEntry(entry())
    store.close()
    const raw = new DatabaseSync(path)
    raw.exec('DROP TABLE entries')
    raw.close()
    store = TallyStore.open(path)
    expect(store.entries({ from: 0, to: 10_000 })).toEqual([])
    expect(store.upsertEntry(entry())).toBe(true)
  })
})
