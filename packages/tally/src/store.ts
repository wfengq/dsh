import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
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

interface EntryRow {
  id: string
  session_id: string
  root_session_id: string
  workspace_id: string | null
  at: number
  route: string
  model: string
  input: number
  cache_read: number
  cache_write: number
  output: number
  reasoning: number | null
  usage_known: number
  deleted: number
}

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
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const present = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map(t => t.name),
    )
    const complete = present.has('entries') && present.has('cursors')
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
  readonly #putCursor: StatementSync
  readonly #getCursor: StatementSync

  private constructor(db: DatabaseSync) {
    this.#db = db
    this.#insert = db.prepare(`
      INSERT INTO entries (
        id, session_id, root_session_id, workspace_id, at, route, model,
        input, cache_read, cache_write, output, reasoning, usage_known, deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING`)
    this.#markDeleted = db.prepare('UPDATE entries SET deleted = 1 WHERE session_id = ?')
    this.#putCursor = db.prepare(`
      INSERT INTO cursors (session_id, last_seq, state) VALUES (?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET last_seq = excluded.last_seq, state = excluded.state`)
    this.#getCursor = db.prepare('SELECT last_seq, state FROM cursors WHERE session_id = ?')
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

  markSessionDeleted(sessionId: string): void {
    this.#markDeleted.run(sessionId)
  }

  setCursor(sessionId: string, c: Cursor): void {
    this.#putCursor.run(sessionId, c.lastSeq, c.state)
  }

  getCursor(sessionId: string): Cursor | undefined {
    const row = this.#getCursor.get(sessionId) as { last_seq: number; state: string } | undefined
    return row === undefined ? undefined : { lastSeq: row.last_seq, state: row.state }
  }

  entries(filter: EntryFilter): StoredEntry[] {
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
    const rows = this.#db
      .prepare(`SELECT * FROM entries WHERE ${where.join(' AND ')} ORDER BY at, id`)
      .all(...params) as unknown as EntryRow[]
    return rows.map(toEntry)
  }

  /** Drops every entry and cursor so the next scan rebuilds from the session logs. */
  reset(): void {
    this.transaction(() => this.#db.exec('DELETE FROM entries; DELETE FROM cursors'))
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

function toEntry(r: EntryRow): StoredEntry {
  const tokens: TallyTokens = {
    input: r.input,
    cacheRead: r.cache_read,
    cacheWrite: r.cache_write,
    output: r.output,
  }
  if (r.reasoning !== null) tokens.reasoning = r.reasoning
  return {
    id: r.id,
    sessionId: r.session_id,
    rootSessionId: r.root_session_id,
    workspaceId: r.workspace_id,
    at: r.at,
    route: r.route,
    model: r.model,
    tokens,
    usageKnown: r.usage_known === 1,
    deleted: r.deleted === 1,
  }
}
