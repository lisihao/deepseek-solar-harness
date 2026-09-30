/** SQLite schema and open-time validation for the local model catalog. */

import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Current physical layout of one model-catalog database. */
export const MODEL_CATALOG_SCHEMA_VERSION = 1

/** SQLite application id that distinguishes this database from other DSH media. */
export const MODEL_CATALOG_SQLITE_APPLICATION_ID = 0x44534d43

const TABLE_COLUMNS = {
  model_catalog_sources: [
    'id',
    'name',
    'provider',
    'menu_visible',
    'state',
    'last_attempt_at',
    'last_success_at',
    'error',
  ],
  model_catalog_models: [
    'source_id',
    'upstream_model_id',
    'name',
    'description',
    'dispatch_provider',
    'dispatch_model',
    'availability',
    'unavailable_reason',
    'evidence',
    'reasoning_json',
    'featured_rank',
    'model_order',
    'in_current_snapshot',
    'last_seen_at',
    'checked_at',
  ],
} as const

/** Exclusively create a missing catalog file with owner-only permissions. */
function createDatabaseFile(path: string): void {
  try {
    const descriptor = openSync(path, 'wx', 0o600)
    closeSync(descriptor)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Ensure an existing version-one database has exactly this package's tables. */
function hasCurrentTables(db: DatabaseSync): boolean {
  for (const [table, expectedColumns] of Object.entries(TABLE_COLUMNS)) {
    const row = db.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(table) as { sql: string } | undefined
    if (row === undefined || !row.sql.includes('STRICT')) return false
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (columns.length !== expectedColumns.length) return false
    if (columns.some(({ name }) => !expectedColumns.includes(name as never))) return false
  }
  return true
}

/** Throw a consistent diagnostic for an unrelated or incomplete database. */
function invalidSchema(path: string): never {
  throw new Error(`model catalog database at "${path}" has an invalid schema`)
}

/** Configure or reject the database while retaining a single writer lock. */
function configureDatabase(db: DatabaseSync, path: string): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('BEGIN IMMEDIATE')
  try {
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const { count: objectCount } = db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
    ).get() as { count: number }
    if (version === 0) {
      if (applicationId !== 0 || objectCount !== 0) invalidSchema(path)
      db.exec(`
        CREATE TABLE model_catalog_sources (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          provider        TEXT NOT NULL,
          menu_visible    INTEGER NOT NULL CHECK (menu_visible IN (0, 1)),
          state           TEXT NOT NULL CHECK (state IN ('unrefreshed', 'ready', 'unavailable', 'error')),
          last_attempt_at TEXT,
          last_success_at TEXT,
          error           TEXT
        ) STRICT;

        CREATE TABLE model_catalog_models (
          source_id           TEXT NOT NULL REFERENCES model_catalog_sources(id) ON DELETE CASCADE,
          upstream_model_id   TEXT NOT NULL,
          name                TEXT NOT NULL,
          description         TEXT,
          dispatch_provider   TEXT NOT NULL,
          dispatch_model      TEXT NOT NULL,
          availability        TEXT NOT NULL CHECK (availability IN ('available', 'unavailable', 'unknown')),
          unavailable_reason  TEXT,
          evidence            TEXT NOT NULL CHECK (evidence IN ('api-list', 'native-list', 'web-picker', 'configuration')),
          reasoning_json      TEXT,
          featured_rank       INTEGER CHECK (featured_rank IS NULL OR featured_rank >= 0),
          model_order         INTEGER NOT NULL CHECK (model_order >= 0),
          in_current_snapshot INTEGER NOT NULL CHECK (in_current_snapshot IN (0, 1)),
          last_seen_at        TEXT NOT NULL,
          checked_at          TEXT NOT NULL,
          PRIMARY KEY (source_id, upstream_model_id)
        ) STRICT;
      `)
      db.exec(`PRAGMA application_id = ${MODEL_CATALOG_SQLITE_APPLICATION_ID}`)
      db.exec(`PRAGMA user_version = ${MODEL_CATALOG_SCHEMA_VERSION}`)
    } else if (version > MODEL_CATALOG_SCHEMA_VERSION) {
      throw new Error(
        `model catalog database at "${path}" has newer schema version ${version} (this build supports ${MODEL_CATALOG_SCHEMA_VERSION})`,
      )
    } else if (version !== MODEL_CATALOG_SCHEMA_VERSION
      || applicationId !== MODEL_CATALOG_SQLITE_APPLICATION_ID
      || objectCount !== Object.keys(TABLE_COLUMNS).length
      || !hasCurrentTables(db)) {
      invalidSchema(path)
    }
    db.exec('COMMIT')
  } catch (error: unknown) {
    /* v8 ignore next 5 -- the original schema failure remains actionable if rollback also fails. */
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original schema failure names the unusable medium.
    }
    throw error
  }
}

/**
 * Open a dedicated model catalog database after preparing its parent path and
 * validating its physical layout.
 * @param databasePath - `:memory:` or a filesystem path for this catalog.
 * @returns an open SQLite connection owned by the catalog service.
 */
export function openModelCatalogDatabase(databasePath: string): DatabaseSync {
  const path = databasePath === ':memory:' ? databasePath : resolve(databasePath)
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    createDatabaseFile(path)
  }
  const db = new DatabaseSync(path)
  try {
    configureDatabase(db, path)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}
