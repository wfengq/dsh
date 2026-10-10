import type * as NodeSqlite from 'node:sqlite'

export type { DatabaseSync, StatementSync } from 'node:sqlite'

const SQLITE_WARNING = 'SQLite is an experimental feature'

function isSqliteExperimentalWarning(warning: unknown, typeOrOptions: unknown): boolean {
  const type = typeof typeOrOptions === 'string'
    ? typeOrOptions
    : (typeOrOptions as { type?: unknown } | null | undefined)?.type
  const message = warning instanceof Error ? warning.message : String(warning)
  const name = warning instanceof Error ? warning.name : type
  return name === 'ExperimentalWarning' && message.startsWith(SQLITE_WARNING)
}

/**
 * Loads `node:sqlite` without letting Node 22 print "ExperimentalWarning: SQLite is an
 * experimental feature" into every dsh run. Only that one warning is dropped, and only while
 * the module loads: `process.emitWarning` is restored before this returns.
 */
function load(): typeof NodeSqlite {
  const emitWarning = process.emitWarning
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest)
  } as typeof process.emitWarning
  try {
    return process.getBuiltinModule('node:sqlite')
  } finally {
    process.emitWarning = emitWarning
  }
}

/** The `node:sqlite` module. */
export const sqlite: typeof NodeSqlite = load()
