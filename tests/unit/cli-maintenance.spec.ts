import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GovernanceStore } from '@dsh-hy-memory/governance'
import { inspectDatabase, migrateDatabase, reindexDatabase, restoreDatabase } from '../../scripts/maintenance.js'

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function createDatabase(): { dir: string; dbPath: string; store: GovernanceStore } {
  const dir = mkdtempSync(join(tmpdir(), 'hymem-cli-maintenance-'))
  dirs.push(dir)
  const dbPath = join(dir, 'governance.db')
  const store = new GovernanceStore(dbPath)
  store.ensureOwner()
  store.ensureProject('test-project')
  return { dir, dbPath, store }
}

describe('CLI maintenance', () => {
  it('rebuilds the keyword index by default and excludes tombstones', () => {
    const { dbPath, store } = createDatabase()
    const live = store.createMemory({
      scene: 'chat', kind: 'fact', title: 'Live marker', content: 'quartzneedle active record',
      scope: 'project', projectId: 'test-project', authorPrincipalId: 'owner',
    }, 'owner')
    const deleted = store.createMemory({
      scene: 'chat', kind: 'fact', title: 'Deleted marker', content: 'quartzneedle deleted record',
      scope: 'project', projectId: 'test-project', authorPrincipalId: 'owner',
    }, 'owner')
    store.transition(deleted.id, 'deleted', 'owner', 'user requested deletion', deleted.revision)
    store.db.exec('DELETE FROM memory_fts')
    store.close()

    const result = reindexDatabase(dbPath)
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const matches = db.prepare("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH 'quartzneedle'").all() as Array<{ memory_id: string }>
      expect(result.dryRun).toBe(false)
      expect(result.indexed).toBe(1)
      expect(matches.map(row => row.memory_id)).toEqual([live.id])
    } finally {
      db.close()
    }
  })

  it('keeps reindex dry-run read-only and does not create a missing database', () => {
    const { dir, dbPath, store } = createDatabase()
    store.close()
    const before = readFileSync(dbPath)

    const result = reindexDatabase(dbPath, true)

    expect(result.dryRun).toBe(true)
    expect(result.pending).toBe(true)
    expect(readFileSync(dbPath).equals(before)).toBe(true)
    const missingPath = join(dir, 'missing', 'governance.db')
    expect(() => reindexDatabase(missingPath, true)).toThrow(/not found/i)
    expect(() => readFileSync(missingPath)).toThrow()
  })

  it('reports pending schema work without creating a missing database in dry-run mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hymem-cli-migrate-'))
    dirs.push(dir)
    const dbPath = join(dir, 'not-created', 'governance.db')

    const result = migrateDatabase(dbPath, true)

    expect(result).toMatchObject({ currentVersion: 0, targetVersion: 1, pending: [1], dryRun: true, applied: false })
    expect(() => readFileSync(dbPath)).toThrow()
  })

  it('creates the current schema when migrate runs without dry-run on a missing database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hymem-cli-migrate-create-'))
    dirs.push(dir)
    const dataDir = join(dir, 'new-data')
    const dbPath = join(dataDir, 'governance.db')

    const result = migrateDatabase(dbPath)
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
      expect(result).toMatchObject({ currentVersion: 1, targetVersion: 1, pending: [], dryRun: false, applied: true, databaseExists: true })
      expect(version.version).toBe(1)
    } finally {
      db.close()
    }
  })

  it('keeps migration dry-run read-only for an existing empty database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hymem-cli-migrate-'))
    dirs.push(dir)
    const dbPath = join(dir, 'governance.db')
    new DatabaseSync(dbPath).close()
    const before = readFileSync(dbPath)

    const result = migrateDatabase(dbPath, true)

    expect(result).toMatchObject({ currentVersion: 0, targetVersion: 1, pending: [1], dryRun: true, applied: false })
    expect(readFileSync(dbPath).equals(before)).toBe(true)
  })

  it('applies the current schema to an existing database by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hymem-cli-migrate-'))
    dirs.push(dir)
    const dbPath = join(dir, 'governance.db')
    new DatabaseSync(dbPath).close()

    const result = migrateDatabase(dbPath)
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
      expect(result).toMatchObject({ currentVersion: 1, targetVersion: 1, pending: [], dryRun: false, applied: true })
      expect(version.version).toBe(1)
    } finally {
      db.close()
    }
  })

  it('refuses to migrate a database from a newer schema and leaves it unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hymem-cli-migrate-'))
    dirs.push(dir)
    const dbPath = join(dir, 'governance.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(2, 'future')
    db.close()
    const before = readFileSync(dbPath)

    expect(() => migrateDatabase(dbPath)).toThrow(/newer than this plugin supports/i)
    expect(readFileSync(dbPath).equals(before)).toBe(true)
  })

  it('refuses to reindex an unsupported newer schema without changing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hymem-cli-reindex-'))
    dirs.push(dir)
    const dbPath = join(dir, 'governance.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(2, 'future')
    db.close()
    const before = readFileSync(dbPath)

    expect(() => reindexDatabase(dbPath)).toThrow(/newer than this plugin supports/i)
    expect(readFileSync(dbPath).equals(before)).toBe(true)
  })

  it('inspects SQLite integrity, schema, and audit state without modifying the database', () => {
    const { dbPath, store } = createDatabase()
    store.close()
    const before = readFileSync(dbPath)

    const result = inspectDatabase(dbPath)

    expect(result).toMatchObject({ exists: true, integrity: 'ok', schemaVersion: 1, schemaSupported: true, auditValid: true })
    expect(readFileSync(dbPath).equals(before)).toBe(true)
  })

  it('reports a missing database without creating it during inspection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hymem-cli-doctor-'))
    dirs.push(dir)
    const dbPath = join(dir, 'missing', 'governance.db')

    expect(inspectDatabase(dbPath)).toMatchObject({ exists: false, integrity: 'missing', schemaVersion: null, reasons: ['database not initialized'] })
    expect(() => readFileSync(dbPath)).toThrow()
  })

  it('restores a validated database into a new target and preserves its audit chain and tombstones', async () => {
    const { dbPath, store } = createDatabase()
    const deleted = store.createMemory({
      scene: 'chat', kind: 'fact', title: 'Deleted marker', content: 'retained tombstone record',
      scope: 'project', projectId: 'test-project', authorPrincipalId: 'owner',
    }, 'owner')
    store.transition(deleted.id, 'deleted', 'owner', 'user requested deletion', deleted.revision)
    store.close()
    const targetDir = join(tmpdir(), `hymem-cli-restore-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    dirs.push(targetDir)

    const result = await restoreDatabase(dbPath, targetDir)
    const restoredPath = join(targetDir, 'governance.db')
    const db = new DatabaseSync(restoredPath, { readOnly: true })
    try {
      const record = db.prepare('SELECT tombstone FROM memory_records WHERE id = ?').get(deleted.id) as { tombstone: number }
      const tombstone = db.prepare('SELECT reason FROM tombstones WHERE memory_id = ?').get(deleted.id) as { reason: string }
      expect(result).toMatchObject({ schemaVersion: 1, tombstones: 1, auditValid: true, restored: true })
      expect(record.tombstone).toBe(1)
      expect(tombstone.reason).toBe('user requested deletion')
    } finally {
      db.close()
    }
  })

  it('rejects an unsupported restore schema and leaves no target behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hymem-cli-restore-future-'))
    dirs.push(dir)
    const sourcePath = join(dir, 'future.db')
    const db = new DatabaseSync(sourcePath)
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(2, 'future')
    db.close()
    const targetDir = join(dir, 'restored')

    await expect(restoreDatabase(sourcePath, targetDir)).rejects.toThrow(/newer than this plugin supports/i)
    expect(() => readFileSync(join(targetDir, 'governance.db'))).toThrow()
  })

  it('rejects a restore source with a broken audit chain before creating the target', async () => {
    const { dir, dbPath, store } = createDatabase()
    store.createMemory({
      scene: 'chat', kind: 'fact', title: 'Audit marker', content: 'chain validation marker',
      scope: 'project', projectId: 'test-project', authorPrincipalId: 'owner',
    }, 'owner')
    store.close()
    const db = new DatabaseSync(dbPath)
    db.exec("UPDATE audit_events SET hash = 'corrupted' WHERE rowid = (SELECT MAX(rowid) FROM audit_events)")
    db.close()
    const targetDir = join(dir, 'restored')

    await expect(restoreDatabase(dbPath, targetDir)).rejects.toThrow(/audit chain is invalid/i)
    expect(() => readFileSync(join(targetDir, 'governance.db'))).toThrow()
  })

  it('rejects an uncheckpointed WAL instead of restoring only the main database file', async () => {
    const { dir, dbPath, store } = createDatabase()
    store.close()
    writeFileSync(`${dbPath}-wal`, Buffer.from('pending WAL data'))
    const targetDir = join(dir, 'restored')

    await expect(restoreDatabase(dbPath, targetDir)).rejects.toThrow(/uncheckpointed WAL/i)
    expect(() => readFileSync(join(targetDir, 'governance.db'))).toThrow()
  })

  it('rejects mismatched tombstone IDs even when marker and deleted-record counts match', async () => {
    const { dir, dbPath, store } = createDatabase()
    const first = store.createMemory({
      scene: 'chat', kind: 'fact', title: 'Deleted', content: 'deleted record',
      scope: 'project', projectId: 'test-project', authorPrincipalId: 'owner',
    }, 'owner')
    const second = store.createMemory({
      scene: 'chat', kind: 'fact', title: 'Live', content: 'live record',
      scope: 'project', projectId: 'test-project', authorPrincipalId: 'owner',
    }, 'owner')
    store.transition(first.id, 'deleted', 'owner', 'delete first', first.revision)
    store.db.prepare('UPDATE tombstones SET memory_id = ? WHERE memory_id = ?').run(second.id, first.id)
    store.close()
    const targetDir = join(dir, 'restored')

    await expect(restoreDatabase(dbPath, targetDir)).rejects.toThrow(/tombstone.*mismatch/i)
    expect(() => readFileSync(join(targetDir, 'governance.db'))).toThrow()
  })

  it('rejects restoring a database into its own directory', async () => {
    const { dir, dbPath, store } = createDatabase()
    store.close()
    const before = readFileSync(dbPath)

    await expect(restoreDatabase(dbPath, dir)).rejects.toThrow(/source and destination must be different/i)
    expect(readFileSync(dbPath).equals(before)).toBe(true)
  })

  it('refuses to overwrite an existing restore target database', async () => {
    const { dbPath, store } = createDatabase()
    store.close()
    const targetDir = mkdtempSync(join(tmpdir(), 'hymem-cli-restore-existing-'))
    dirs.push(targetDir)
    const existingDbPath = join(targetDir, 'governance.db')
    const existing = Buffer.from('keep existing database')
    writeFileSync(existingDbPath, existing)

    await expect(restoreDatabase(dbPath, targetDir)).rejects.toThrow(/already exists/i)
    expect(readFileSync(existingDbPath).equals(existing)).toBe(true)
  })
})
