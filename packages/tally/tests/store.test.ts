import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqlite } from '../src/sqlite.js'
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

/** Entry ids sorted, since reads come back in no particular order. */
function ids(rows: StoredEntry[]): string[] {
  return rows.map(e => e.id).sort()
}

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
  it('reads one session by closed seq range, ordered by time and then numeric seq', () => {
    store = TallyStore.open(path)
    // Same timestamp: seq 10 must sort after seq 9 (numerically, not as text), and a colon in the session id must not confuse the seq.
    for (const [id, sessionId, at] of [
      ['s1:10', 's1', 2000], ['s1:9', 's1', 2000], ['s1:2', 's1', 1000], ['s1:20', 's1', 3000], ['s10:5', 's10', 1000], ['a:b:7', 'a:b', 1500],
    ] as const) store.upsertEntry(entry({ id, sessionId, at }))
    expect(store.sessionEntries('s1').map(e => e.id)).toEqual(['s1:2', 's1:9', 's1:10', 's1:20'])
    expect(store.sessionEntries('s1', { from: 9, to: 10 }).map(e => e.id)).toEqual(['s1:9', 's1:10'])
    expect(store.sessionEntries('s1', { from: 3, to: 8 })).toEqual([])
    expect(store.sessionEntries('a:b', { from: 7, to: 7 }).map(e => e.id)).toEqual(['a:b:7'])
    expect(store.latestSessionEntry('s1')?.id).toBe('s1:20')
    expect(store.latestSessionEntry('nobody')).toBeUndefined()
    store.upsertEntry(entry({ id: 's1:21', at: 3000 }))
    expect(store.latestSessionEntry('s1')?.id).toBe('s1:21')
  })

  it('opens without printing the SQLite ExperimentalWarning and keeps other warnings', () => {
    // A fresh process, since Node prints each experimental warning only once per process.
    // Runs the built entry (`pnpm test` builds first), as dsh would load it.
    const lib = new URL('../lib/store.js', import.meta.url).href
    const script = [
      `const { TallyStore } = await import(${JSON.stringify(lib)})`,
      'TallyStore.open(process.env.TALLY_DB).close()',
      "process.emitWarning('another feature', 'ExperimentalWarning')",
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, TALLY_DB: path, NODE_OPTIONS: '' },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).not.toContain('SQLite')
    expect(result.stderr).toContain('ExperimentalWarning: another feature')
  })

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
    expect(ids(store.entries({ from: 100, to: 300 }))).toEqual(['s1:1', 's1:2'])
  })

  it('filters by route, model, root session and session ids', () => {
    store = TallyStore.open(path)
    store.upsertEntry(entry({ id: 's1:1', at: 1 }))
    store.upsertEntry(entry({ id: 's2:1', sessionId: 's2', rootSessionId: 'other', route: 'r2', model: 'm2', at: 2 }))
    store.upsertEntry(entry({ id: 's3:1', sessionId: 's3', at: 3 }))
    const range = { from: 0, to: 10 }
    expect(ids(store.entries({ ...range, route: 'r2' }))).toEqual(['s2:1'])
    expect(ids(store.entries({ ...range, model: 'm2' }))).toEqual(['s2:1'])
    expect(ids(store.entries({ ...range, rootSessionId: 'root' }))).toEqual(['s1:1', 's3:1'])
    expect(ids(store.entries({ ...range, sessionIds: ['s1', 's2'] }))).toEqual(['s1:1', 's2:1'])
    expect(store.entries({ ...range, sessionIds: [] })).toEqual([])
  })

  it('reads only the usage columns, with the same filters', () => {
    store = TallyStore.open(path)
    store.upsertEntry(entry({ id: 's1:1', at: 1, tokens: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 5 } }))
    store.upsertEntry(entry({ id: 's2:1', sessionId: 's2', rootSessionId: 'other', workspaceId: null, usageKnown: false, at: 2 }))
    const range = { from: 0, to: 10 }
    const rows = store.usage(range).sort((a, b) => a.at - b.at)
    expect(rows).toEqual([
      {
        sessionId: 's1', workspaceId: '/work', at: 1, route: 'deepseek-official', model: 'deepseek-flash',
        tokens: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 5 }, usageKnown: true, deleted: false,
      },
      {
        sessionId: 's2', workspaceId: null, at: 2, route: 'deepseek-official', model: 'deepseek-flash',
        tokens: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50 }, usageKnown: false, deleted: false,
      },
    ])
    expect(store.usage({ ...range, rootSessionId: 'other' }).map(r => r.sessionId)).toEqual(['s2'])
    expect(store.usage({ ...range, sessionIds: [] })).toEqual([])
  })

  it('marks a session deleted and restores it, listing ledger sessions with their flags', () => {
    store = TallyStore.open(path)
    store.upsertEntry(entry({ id: 's1:1', at: 1 }))
    store.upsertEntry(entry({ id: 's1:2', at: 2 }))
    store.upsertEntry(entry({ id: 's2:1', sessionId: 's2', at: 3 }))
    const flags = () => store.ledgerSessions().sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))
    expect(flags()).toEqual([
      { sessionId: 's1', allDeleted: false, anyDeleted: false },
      { sessionId: 's2', allDeleted: false, anyDeleted: false },
    ])
    store.markSessionDeleted('s1')
    expect(store.usage({ from: 0, to: 10 }).map(r => [r.sessionId, r.deleted]).sort()).toEqual([['s1', true], ['s1', true], ['s2', false]])
    expect(store.entries({ from: 0, to: 10 }).filter(e => e.deleted).map(e => e.id).sort()).toEqual(['s1:1', 's1:2'])
    // An entry recorded after the mark is not deleted yet.
    store.upsertEntry(entry({ id: 's1:3', at: 4 }))
    expect(flags()[0]).toEqual({ sessionId: 's1', allDeleted: false, anyDeleted: true })
    store.markSessionRestored('s1')
    expect(flags()[0]).toEqual({ sessionId: 's1', allDeleted: false, anyDeleted: false })
    expect(store.usage({ from: 0, to: 10 }).some(r => r.deleted)).toBe(false)
  })

  it('clears all tables when user_version differs', () => {
    store = TallyStore.open(path)
    store.upsertEntry(entry())
    store.setCursor('s1', { lastSeq: 3, state: '{}' })
    store.close()
    const raw = new sqlite.DatabaseSync(path)
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

  it('opens in WAL mode', () => {
    store = TallyStore.open(path)
    store.upsertEntry(entry())
    const raw = new sqlite.DatabaseSync(path)
    expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    raw.close()
  })

  it('never lets stale WAL sidecars of a broken database reach the fresh one', () => {
    writeFileSync(path, Buffer.from('not a database'))
    writeFileSync(path + '-wal', Buffer.from('stale wal'))
    writeFileSync(path + '-shm', Buffer.from('stale shm'))
    store = TallyStore.open(path)
    expect(store.upsertEntry(entry())).toBe(true)
    // SQLite may delete the sidecars when the broken handle closes; whatever survives is set aside.
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(path + ext)) expect(readFileSync(path + ext).toString()).not.toMatch(/^stale/)
    }
    const aside = readdirSync(dir).filter(f => f.includes('.corrupt-'))
    expect(aside.filter(f => f.startsWith('tally.v1.sqlite.corrupt-'))).toHaveLength(1)
    for (const f of aside) expect(readFileSync(join(dir, f)).toString()).toMatch(/^(not a database|stale)/)
    store.close()
    store = TallyStore.open(path)
    expect(store.entries({ from: 0, to: 10_000 })).toHaveLength(1)
  })

  it('stores, overwrites and deletes meta values', () => {
    store = TallyStore.open(path)
    expect(store.getMeta('k')).toBeUndefined()
    store.setMeta('k', 'a')
    store.setMeta('k', 'b')
    expect(store.getMeta('k')).toBe('b')
    store.close()
    store = TallyStore.open(path)
    expect(store.getMeta('k')).toBe('b')
    store.deleteMeta('k')
    expect(store.getMeta('k')).toBeUndefined()
  })

  it('reset also clears meta values', () => {
    store = TallyStore.open(path)
    store.setMeta('k', 'a')
    store.reset()
    expect(store.getMeta('k')).toBeUndefined()
  })

  it('rebuilds when the meta table is missing at the current user_version', () => {
    store = TallyStore.open(path)
    store.upsertEntry(entry())
    store.close()
    const raw = new sqlite.DatabaseSync(path)
    raw.exec('DROP TABLE meta')
    raw.close()
    store = TallyStore.open(path)
    expect(store.entries({ from: 0, to: 10_000 })).toEqual([])
    store.setMeta('k', 'v')
    expect(store.getMeta('k')).toBe('v')
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
    const raw = new sqlite.DatabaseSync(path)
    raw.exec('DROP TABLE entries')
    raw.close()
    store = TallyStore.open(path)
    expect(store.entries({ from: 0, to: 10_000 })).toEqual([])
    expect(store.upsertEntry(entry())).toBe(true)
  })

  it('lists the distinct routes in the ledger, sorted', () => {
    store = TallyStore.open(join(dir, 'routes.sqlite'))
    expect(store.distinctRoutes()).toEqual([])
    store.upsertEntry(entry({ id: 's1:1', route: 'z-route' }))
    store.upsertEntry(entry({ id: 's1:2', route: 'a-route' }))
    store.upsertEntry(entry({ id: 's1:3', route: 'z-route' }))
    expect(store.distinctRoutes()).toEqual(['a-route', 'z-route'])
  })
})
