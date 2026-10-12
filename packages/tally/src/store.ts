import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { sqlite, type DatabaseSync, type StatementSync } from './sqlite.js'
import type { TallyTokens } from 'dsh-tally-api'

/** Bump together with the schema below; a mismatch drops and rebuilds every table. */
const SCHEMA_VERSION = 1

// SQLite primary result codes (extended codes are masked down to these).
const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26

export interface StoredEntry {
  /** `sessionId + ':' + seq`. */
  id: string
  sessionId: string
  rootSessionId: string
  workspaceId: string | null
  at: number
  route: string
  model: string
  tokens: TallyTokens
  usageKnown: boolean
  deleted: boolean
}

export interface EntryFilter {
  /** Inclusive lower bound on `at`. */
  from: number
  /** Exclusive upper bound on `at`. */
  to: number
  route?: string
  model?: string
  rootSessionId?: string
  sessionIds?: string[]
}

export interface Cursor {
  lastSeq: number
  state: string
}

/**
 * What usage queries read for one entry: every field that aggregation, `session()` and the
 * query filters use. `StoredEntry` is a superset, so full entries can be passed where rows are expected.
 */
export type UsageRow = Pick<StoredEntry, 'sessionId' | 'workspaceId' | 'at' | 'route' | 'model' | 'tokens' | 'usageKnown'>
  & Partial<Pick<StoredEntry, 'deleted'>>

/** Column lists for array-mode reads; the row mappers below index into them by position. */
const ENTRY_COLUMNS = 'id, session_id, root_session_id, workspace_id, at, route, model, input, cache_read, cache_write, output, reasoning, usage_known, deleted'
const USAGE_COLUMNS = 'session_id, workspace_id, at, route, model, input, cache_read, cache_write, output, reasoning, usage_known, deleted'

/** A row read with `setReturnArrays(true)`, in the order of its column list. */
type ArrayRow = unknown[]

/** The `seq` part of an entry id (`sessionId + ':' + seq`). */
const SEQ_OF_ID = 'CAST(substr(id, length(session_id) + 2) AS INTEGER)'

const SCHEMA = `
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  workspace_id TEXT,
  at INTEGER NOT NULL,
  route TEXT NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  output INTEGER NOT NULL,
  reasoning INTEGER,
  usage_known INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX entries_at ON entries (at);
CREATE INDEX entries_session ON entries (session_id);
CREATE TABLE cursors (
  session_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL,
  state TEXT NOT NULL
);
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

function sqliteCode(error: unknown): number | undefined {
  const errcode = (error as { errcode?: unknown } | null)?.errcode
  return typeof errcode === 'number' ? errcode & 0xff : undefined
}

function isNotDatabase(error: unknown): boolean {
  const code = sqliteCode(error)
  return code === SQLITE_NOTADB || code === SQLITE_CORRUPT
}

/** Opens `path` and validates it, rebuilding the schema when `user_version` differs. */
function openDatabase(path: string): DatabaseSync {
  const db = new sqlite.DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    // WAL lets queries read while the recorder writes; NORMAL is durable enough for a rebuildable index.
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const present = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map(t => t.name),
    )
    const complete = present.has('entries') && present.has('cursors') && present.has('meta')
    if (row.user_version !== SCHEMA_VERSION || !complete) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as Array<{ name: string }>
        for (const { name } of tables) db.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`)
        db.exec(SCHEMA)
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/**
 * A read-only handle. A WAL database still needs its `-shm` file, which SQLite creates next to
 * the database even for readers; in a directory the reader cannot write to (a backup, another
 * user's DSH_HOME) that fails. Without a `-wal` file there is nothing uncheckpointed, so the file
 * is then opened as immutable; with one, reading it would skip recent entries, so it is an error.
 */
function openReadOnlyHandle(path: string): DatabaseSync {
  let db: DatabaseSync | undefined
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true })
    db.prepare('PRAGMA user_version').get()
    return db
  } catch (error) {
    db?.close()
    if (!/readonly|unable to open/i.test(String((error as Error)?.message))) throw error
    if (existsSync(path + '-wal')) {
      throw new Error(`账本所在目录不可写，无法读取 WAL 模式的数据库：${path}（请把数据库连同 -wal 文件复制到可写目录后再对账）`)
    }
    return new sqlite.DatabaseSync(`file:${encodeURI(path)}?immutable=1`, { readOnly: true })
  }
}

/** The ledger is rebuildable from session logs, so a broken file is set aside, not repaired. */
function quarantine(path: string): void {
  const suffix = `.corrupt-${Date.now()}`
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    if (existsSync(path + ext)) renameSync(path + ext, path + ext + suffix)
  }
}

export class TallyStore {
  static open(path: string): TallyStore {
    mkdirSync(dirname(path), { recursive: true })
    try {
      return TallyStore.#create(path)
    } catch (error) {
      if (!isNotDatabase(error)) throw error
      quarantine(path)
      return TallyStore.#create(path)
    }
  }

  /**
   * Opens an existing ledger for reading only (the reconcile CLI). Never creates, migrates or
   * quarantines anything: a missing file or a different schema version is an error.
   */
  static openReadOnly(path: string): TallyStore {
    if (!existsSync(path)) throw new Error('找不到账本数据库：' + path)
    const db = openReadOnlyHandle(path)
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (row.user_version !== SCHEMA_VERSION) {
        throw new Error(`账本数据库版本不匹配（${row.user_version}，应为 ${SCHEMA_VERSION}）：请先在 dsh 中打开一次 dsh-tally 让它重建账本`)
      }
      return new TallyStore(db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  /** Opens, validates and prepares statements; the handle is closed on any failure. */
  static #create(path: string): TallyStore {
    const db = openDatabase(path)
    try {
      return new TallyStore(db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  readonly #db: DatabaseSync
  #inTransaction = false
  readonly #insert: StatementSync
  readonly #markDeleted: StatementSync
  readonly #markRestored: StatementSync
  readonly #ledgerSessions: StatementSync
  readonly #putCursor: StatementSync
  readonly #getCursor: StatementSync
  readonly #getMeta: StatementSync
  readonly #putMeta: StatementSync
  readonly #deleteMeta: StatementSync

  private constructor(db: DatabaseSync) {
    this.#db = db
    this.#insert = db.prepare(`
      INSERT INTO entries (
        id, session_id, root_session_id, workspace_id, at, route, model,
        input, cache_read, cache_write, output, reasoning, usage_known, deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING`)
    this.#markDeleted = db.prepare('UPDATE entries SET deleted = 1 WHERE session_id = ? AND deleted = 0')
    this.#markRestored = db.prepare('UPDATE entries SET deleted = 0 WHERE session_id = ? AND deleted = 1')
    this.#ledgerSessions = db.prepare('SELECT session_id, MIN(deleted), MAX(deleted) FROM entries GROUP BY session_id')
    this.#ledgerSessions.setReturnArrays(true)
    this.#putCursor = db.prepare(`
      INSERT INTO cursors (session_id, last_seq, state) VALUES (?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET last_seq = excluded.last_seq, state = excluded.state`)
    this.#getCursor = db.prepare('SELECT last_seq, state FROM cursors WHERE session_id = ?')
    this.#getMeta = db.prepare('SELECT value FROM meta WHERE key = ?')
    this.#putMeta = db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
    this.#deleteMeta = db.prepare('DELETE FROM meta WHERE key = ?')
  }

  /** Inserts the entry unless its id exists; returns whether a row was added. */
  upsertEntry(e: StoredEntry): boolean {
    const result = this.#insert.run(
      e.id, e.sessionId, e.rootSessionId, e.workspaceId, e.at, e.route, e.model,
      e.tokens.input, e.tokens.cacheRead, e.tokens.cacheWrite, e.tokens.output,
      e.tokens.reasoning ?? null, e.usageKnown ? 1 : 0, e.deleted ? 1 : 0,
    )
    return Number(result.changes) > 0
  }

  /** Flags every entry of a session as belonging to a deleted session. Amounts are unaffected. */
  markSessionDeleted(sessionId: string): void {
    this.#markDeleted.run(sessionId)
  }

  /** Clears the deleted flag of a session's entries (the session was listed again). */
  markSessionRestored(sessionId: string): void {
    this.#markRestored.run(sessionId)
  }

  /**
   * Every session that has entries, with whether all / any of its entries are marked deleted
   * (they differ when entries were added after the session was marked).
   */
  ledgerSessions(): { sessionId: string; allDeleted: boolean; anyDeleted: boolean }[] {
    return (this.#ledgerSessions.all() as unknown as ArrayRow[])
      .map(r => ({ sessionId: r[0] as string, allDeleted: r[1] === 1, anyDeleted: r[2] === 1 }))
  }

  setCursor(sessionId: string, c: Cursor): void {
    this.#putCursor.run(sessionId, c.lastSeq, c.state)
  }

  getCursor(sessionId: string): Cursor | undefined {
    const row = this.#getCursor.get(sessionId) as { last_seq: number; state: string } | undefined
    return row === undefined ? undefined : { lastSeq: row.last_seq, state: row.state }
  }

  getMeta(key: string): string | undefined {
    const row = this.#getMeta.get(key) as { value: string } | undefined
    return row?.value
  }

  setMeta(key: string, value: string): void {
    this.#putMeta.run(key, value)
  }

  deleteMeta(key: string): void {
    this.#deleteMeta.run(key)
  }

  /** Full entries matching `filter`, in no particular order. */
  entries(filter: EntryFilter): StoredEntry[] {
    return this.#select(ENTRY_COLUMNS, filter).map(toEntry)
  }

  /** Every route that appears in the ledger, deleted sessions included, sorted. */
  distinctRoutes(): string[] {
    const rows = this.#db.prepare('SELECT DISTINCT route FROM entries ORDER BY route').all() as Array<{ route: string }>
    return rows.map(r => r.route)
  }

  /**
   * The usage columns of entries matching `filter`, in no particular order: the read behind
   * `query()` and `session()`, kept to the columns they use because it can cover the whole ledger.
   */
  usage(filter: EntryFilter): UsageRow[] {
    return this.#select(USAGE_COLUMNS, filter).map(toUsageRow)
  }

  /**
   * Entries of one session ordered by time, then by `seq`. `seqRange` keeps only entries whose
   * `seq` (the number after the session id in the entry id) lies in that closed interval.
   */
  sessionEntries(sessionId: string, seqRange?: { from: number; to: number }): StoredEntry[] {
    const range = seqRange === undefined ? '' : ` AND ${SEQ_OF_ID} BETWEEN ? AND ?`
    const statement = this.#db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE session_id = ?${range} ORDER BY at, ${SEQ_OF_ID}`)
    statement.setReturnArrays(true)
    const params = seqRange === undefined ? [sessionId] : [sessionId, seqRange.from, seqRange.to]
    return (statement.all(...params) as unknown as ArrayRow[]).map(toEntry)
  }

  /** The newest entry of one session (by time, then `seq`), if it has any. */
  latestSessionEntry(sessionId: string): StoredEntry | undefined {
    const statement = this.#db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE session_id = ? ORDER BY at DESC, ${SEQ_OF_ID} DESC LIMIT 1`)
    statement.setReturnArrays(true)
    const rows = statement.all(sessionId) as unknown as ArrayRow[]
    return rows[0] === undefined ? undefined : toEntry(rows[0])
  }

  #select(columns: string, filter: EntryFilter): ArrayRow[] {
    const where = ['at >= ?', 'at < ?']
    const params: Array<string | number> = [filter.from, filter.to]
    if (filter.route !== undefined) { where.push('route = ?'); params.push(filter.route) }
    if (filter.model !== undefined) { where.push('model = ?'); params.push(filter.model) }
    if (filter.rootSessionId !== undefined) { where.push('root_session_id = ?'); params.push(filter.rootSessionId) }
    if (filter.sessionIds !== undefined) {
      if (filter.sessionIds.length === 0) return []
      where.push(`session_id IN (${filter.sessionIds.map(() => '?').join(', ')})`)
      params.push(...filter.sessionIds)
    }
    // No ORDER BY: no caller needs an order (aggregation groups and sorts its groups), and the
    // planner need not sort. Array rows skip building a keyed object per row, which is most of
    // the cost of reading a large range.
    const statement = this.#db.prepare(`SELECT ${columns} FROM entries WHERE ${where.join(' AND ')}`)
    statement.setReturnArrays(true)
    return statement.all(...params) as unknown as ArrayRow[]
  }

  /** Drops every entry, cursor and meta value so the next scan rebuilds from the session logs. */
  reset(): void {
    this.transaction(() => this.#db.exec('DELETE FROM entries; DELETE FROM cursors; DELETE FROM meta'))
  }

  /**
   * Runs `fn` atomically: commits on return, rolls back and rethrows on error.
   * Nested calls run inline inside the outer transaction.
   */
  transaction<T>(fn: () => T): T {
    if (this.#inTransaction) return fn()
    this.#db.exec('BEGIN IMMEDIATE')
    this.#inTransaction = true
    try {
      const result = fn()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK')
      } catch {
        // The original failure is the useful one.
      }
      throw error
    } finally {
      this.#inTransaction = false
    }
  }

  close(): void {
    this.#db.close()
  }
}

function tokensOf(input: unknown, cacheRead: unknown, cacheWrite: unknown, output: unknown, reasoning: unknown): TallyTokens {
  const tokens: TallyTokens = {
    input: input as number,
    cacheRead: cacheRead as number,
    cacheWrite: cacheWrite as number,
    output: output as number,
  }
  if (reasoning !== null) tokens.reasoning = reasoning as number
  return tokens
}

/** Maps a row of {@link ENTRY_COLUMNS}. */
function toEntry(r: ArrayRow): StoredEntry {
  return {
    id: r[0] as string,
    sessionId: r[1] as string,
    rootSessionId: r[2] as string,
    workspaceId: r[3] as string | null,
    at: r[4] as number,
    route: r[5] as string,
    model: r[6] as string,
    tokens: tokensOf(r[7], r[8], r[9], r[10], r[11]),
    usageKnown: r[12] === 1,
    deleted: r[13] === 1,
  }
}

/** Maps a row of {@link USAGE_COLUMNS}. */
function toUsageRow(r: ArrayRow): UsageRow {
  return {
    sessionId: r[0] as string,
    workspaceId: r[1] as string | null,
    at: r[2] as number,
    route: r[3] as string,
    model: r[4] as string,
    tokens: tokensOf(r[5], r[6], r[7], r[8], r[9]),
    usageKnown: r[10] === 1,
    deleted: r[11] === 1,
  }
}
