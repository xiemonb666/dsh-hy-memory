import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { canonicalJson, sha256 } from '../packages/contracts/src/index.js'
import { GovernanceStore, SCHEMA_VERSION } from '../packages/governance/src/index.js'

export interface ReindexResult {
  dryRun: boolean
  memories: number
  tombstones: number
  indexed: number
  pending: boolean
}

export interface MigrationResult {
  currentVersion: number
  targetVersion: number
  pending: number[]
  dryRun: boolean
  applied: boolean
  databaseExists: boolean
}

export interface DatabaseInspection {
  exists: boolean
  integrity: 'ok' | 'failed' | 'missing'
  schemaVersion: number | null
  schemaSupported: boolean
  memories: number | null
  tombstones: number | null
  auditValid: boolean | null
  auditEvents: number | null
  reasons: string[]
}

export interface RestoreResult {
  restored: true
  databasePath: string
  schemaVersion: number
  memories: number
  tombstones: number
  auditEvents: number
  auditValid: true
}

interface SchemaInfo {
  version: number
  tables: string[]
}

interface AuditInfo {
  valid: boolean
  eventCount: number
  headHash: string | null
  brokenAt?: string
}

interface ValidatedDatabase {
  schemaVersion: number
  totalMemories: number
  liveMemories: number
  tombstones: number
  tombstoneDigest: string
  audit: AuditInfo
}

const REQUIRED_TABLE_COLUMNS: Record<string, string[]> = {
  schema_migrations: ['version', 'applied_at'],
  memory_records: ['id', 'title', 'canonical_text', 'tombstone'],
  memory_fts: ['memory_id', 'title', 'content'],
  tombstones: ['memory_id', 'reason', 'actor', 'created_at'],
  audit_events: ['id', 'actor', 'operation', 'target', 'outcome', 'detail_json', 'created_at', 'prev_hash', 'hash'],
}

function assertIntegrity(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
  const failures = rows.map(row => row.integrity_check).filter(result => result !== 'ok')
  if (failures.length > 0) throw new Error(`database integrity check failed: ${failures.join('; ')}`)
  const foreignKeyFailures = db.prepare('PRAGMA foreign_key_check').all()
  if (foreignKeyFailures.length > 0) throw new Error(`database foreign key check failed (${foreignKeyFailures.length} violation(s))`)
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
}

function readSchemaInfo(db: DatabaseSync): SchemaInfo {
  const tables = tableNames(db)
  if (!tables.includes('schema_migrations')) return { version: 0, tables }
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }
  return { version: row.version ?? 0, tables }
}

function assertCurrentSchema(db: DatabaseSync, schema: SchemaInfo): void {
  if (schema.version > SCHEMA_VERSION) {
    throw new Error(`database schema ${schema.version} is newer than this plugin supports (${SCHEMA_VERSION})`)
  }
  if (schema.version < SCHEMA_VERSION) {
    throw new Error(`database schema ${schema.version} needs migration to ${SCHEMA_VERSION}`)
  }
  for (const [table, requiredColumns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
    if (!schema.tables.includes(table)) throw new Error(`database schema is missing required table ${table}`)
    const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(row => row.name)
    const missing = requiredColumns.filter(column => !columns.includes(column))
    if (missing.length > 0) throw new Error(`database schema table ${table} is missing column(s): ${missing.join(', ')}`)
  }
}

function assertTombstoneConsistency(db: DatabaseSync): void {
  const mismatch = db.prepare(`
    SELECT m.id FROM memory_records m
    WHERE m.tombstone <> CASE WHEN EXISTS (
      SELECT 1 FROM tombstones t WHERE t.memory_id = m.id
    ) THEN 1 ELSE 0 END LIMIT 1
  `).get() as { id: string } | undefined
  if (mismatch) throw new Error(`database tombstone table mismatch at memory ${mismatch.id}`)
}

function readAuditInfo(db: DatabaseSync): AuditInfo {
  const rows = db.prepare('SELECT id, actor, operation, target, outcome, detail_json, created_at, prev_hash, hash FROM audit_events ORDER BY created_at ASC, rowid ASC').all() as Array<{
    id: string
    actor: string
    operation: string
    target: string
    outcome: string
    detail_json: string
    created_at: string
    prev_hash: string | null
    hash: string
  }>
  let previous: string | null = null
  for (const row of rows) {
    try {
      const expected = sha256(canonicalJson({
        actor: row.actor,
        operation: row.operation,
        target: row.target,
        outcome: row.outcome,
        detail: JSON.parse(row.detail_json) as unknown,
        createdAt: row.created_at,
        prev: previous ?? '',
      }))
      if (expected !== row.hash || (row.prev_hash ?? null) !== previous) {
        return { valid: false, eventCount: rows.length, headHash: rows.at(-1)?.hash ?? null, brokenAt: row.id }
      }
      previous = row.hash
    } catch {
      return { valid: false, eventCount: rows.length, headHash: rows.at(-1)?.hash ?? null, brokenAt: row.id }
    }
  }
  return { valid: true, eventCount: rows.length, headHash: rows.at(-1)?.hash ?? null }
}

function validateDatabase(path: string): ValidatedDatabase {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    assertIntegrity(db)
    const schema = readSchemaInfo(db)
    assertCurrentSchema(db, schema)
    const all = db.prepare('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number }
    const live = db.prepare('SELECT COUNT(*) AS count FROM memory_records WHERE tombstone = 0').get() as { count: number }
    const tombstoneRecords = db.prepare('SELECT COUNT(*) AS count FROM memory_records WHERE tombstone = 1').get() as { count: number }
    const tombstones = db.prepare('SELECT COUNT(*) AS count FROM tombstones').get() as { count: number }
    if (tombstoneRecords.count !== tombstones.count) {
      throw new Error(`database tombstone table mismatch (${tombstoneRecords.count} records, ${tombstones.count} markers)`)
    }
    assertTombstoneConsistency(db)
    const tombstoneRows = db.prepare('SELECT memory_id, reason, actor, created_at FROM tombstones ORDER BY memory_id').all()
    const audit = readAuditInfo(db)
    if (!audit.valid) throw new Error(`database audit chain is invalid at ${audit.brokenAt ?? 'unknown row'}`)
    return {
      schemaVersion: schema.version,
      totalMemories: all.count,
      liveMemories: live.count,
      tombstones: tombstones.count,
      tombstoneDigest: sha256(canonicalJson(tombstoneRows)),
      audit,
    }
  } finally {
    db.close()
  }
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`path contains a symbolic link: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

function pathIsWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function rejectUncheckpointedWal(path: string): void {
  const walPath = `${path}-wal`
  if (!existsSync(walPath)) return
  if (statSync(walPath).size > 0) throw new Error(`source database has an uncheckpointed WAL file: ${walPath}; create a fresh backup after checkpointing`)
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export function inspectDatabase(dbPath: string): DatabaseInspection {
  if (!existsSync(dbPath)) {
    return {
      exists: false,
      integrity: 'missing',
      schemaVersion: null,
      schemaSupported: false,
      memories: null,
      tombstones: null,
      auditValid: null,
      auditEvents: null,
      reasons: ['database not initialized'],
    }
  }

  let db: DatabaseSync | undefined
  const result: DatabaseInspection = {
    exists: true,
    integrity: 'failed',
    schemaVersion: null,
    schemaSupported: false,
    memories: null,
    tombstones: null,
    auditValid: null,
    auditEvents: null,
    reasons: [],
  }
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    assertIntegrity(db)
    result.integrity = 'ok'
    const schema = readSchemaInfo(db)
    result.schemaVersion = schema.version
    if (schema.version > SCHEMA_VERSION) {
      result.reasons.push(`schema ${schema.version} is newer than supported schema ${SCHEMA_VERSION}`)
      return result
    }
    if (schema.version !== SCHEMA_VERSION) {
      result.reasons.push(`schema ${schema.version} is not the current schema ${SCHEMA_VERSION}`)
      return result
    }
    assertCurrentSchema(db, schema)
    result.schemaSupported = true
    const memoryCount = db.prepare('SELECT COUNT(*) AS count FROM memory_records WHERE tombstone = 0').get() as { count: number }
    const tombstoneCount = db.prepare('SELECT COUNT(*) AS count FROM tombstones').get() as { count: number }
    result.memories = memoryCount.count
    result.tombstones = tombstoneCount.count
    assertTombstoneConsistency(db)
    const audit = readAuditInfo(db)
    result.auditValid = audit.valid
    result.auditEvents = audit.eventCount
    if (!audit.valid) result.reasons.push(`audit chain is invalid at ${audit.brokenAt ?? 'unknown row'}`)
  } catch (error) {
    result.reasons.push(error instanceof Error ? error.message : String(error))
  } finally {
    db?.close()
  }
  return result
}

export function migrateDatabase(dbPath: string, dryRun = false): MigrationResult {
  const databaseExists = existsSync(dbPath)
  let schema: SchemaInfo = { version: 0, tables: [] }
  if (databaseExists) {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assertIntegrity(db)
      schema = readSchemaInfo(db)
    } finally {
      db.close()
    }
  }
  if (schema.version > SCHEMA_VERSION) {
    throw new Error(`database schema ${schema.version} is newer than this plugin supports (${SCHEMA_VERSION})`)
  }
  if (databaseExists && schema.version === 0 && schema.tables.length > 0) {
    throw new Error('database has tables but no recognized schema migration; refusing to migrate an unknown database')
  }
  const pending = Array.from({ length: Math.max(0, SCHEMA_VERSION - schema.version) }, (_, index) => schema.version + index + 1)
  if (!databaseExists && !dryRun) {
    const store = new GovernanceStore(dbPath)
    store.close()
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assertIntegrity(db)
      const resultingSchema = readSchemaInfo(db)
      assertCurrentSchema(db, resultingSchema)
    } finally {
      db.close()
    }
    return { currentVersion: SCHEMA_VERSION, targetVersion: SCHEMA_VERSION, pending: [], dryRun: false, applied: true, databaseExists: true }
  }
  if (dryRun || pending.length === 0) {
    if (databaseExists && schema.version === SCHEMA_VERSION) {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        assertCurrentSchema(db, schema)
      } finally {
        db.close()
      }
    }
    return { currentVersion: schema.version, targetVersion: SCHEMA_VERSION, pending, dryRun, applied: false, databaseExists }
  }
  const store = new GovernanceStore(dbPath)
  store.close()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    assertIntegrity(db)
    const resultingSchema = readSchemaInfo(db)
    assertCurrentSchema(db, resultingSchema)
    if (resultingSchema.version !== SCHEMA_VERSION) {
      throw new Error(`migration did not reach schema ${SCHEMA_VERSION}; database reports ${resultingSchema.version}`)
    }
  } finally {
    db.close()
  }
  return { currentVersion: SCHEMA_VERSION, targetVersion: SCHEMA_VERSION, pending: [], dryRun: false, applied: true, databaseExists }
}

export function reindexDatabase(dbPath: string, dryRun = false): ReindexResult {
  if (!existsSync(dbPath)) throw new Error(`governance database not found: ${dbPath}`)
  const inspection = validateDatabase(dbPath)
  const totals = { memories: inspection.liveMemories, tombstones: inspection.tombstones }
  if (dryRun) return { ...totals, dryRun: true, indexed: 0, pending: true }

  const db = new DatabaseSync(dbPath)
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec('DELETE FROM memory_fts')
    db.exec('INSERT INTO memory_fts(memory_id, title, content) SELECT id, title, canonical_text FROM memory_records WHERE tombstone = 0')
    const indexed = db.prepare('SELECT COUNT(*) AS count FROM memory_fts').get() as { count: number }
    if (indexed.count !== totals.memories) throw new Error('keyword index row count does not match live memory count')
    db.exec('COMMIT')
    return { ...totals, dryRun: false, indexed: indexed.count, pending: false }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Ignore a rollback error; preserve the original database failure.
    }
    throw error
  } finally {
    db.close()
  }
}

export async function restoreDatabase(sourceInput: string, targetInput: string): Promise<RestoreResult> {
  if (!sourceInput.trim()) throw new Error('restore requires --source <path>')
  if (!targetInput.trim()) throw new Error('restore requires --data-dir <new target directory>')
  const sourcePath = resolve(sourceInput)
  const targetDir = resolve(targetInput)
  const targetDbPath = join(targetDir, 'governance.db')
  if (targetDir === parse(targetDir).root) throw new Error('restore target must not be a filesystem root')
  if (sourcePath === targetDbPath || pathIsWithin(targetDir, sourcePath)) throw new Error('restore source and destination must be different paths')
  assertNoSymlinkComponents(sourcePath)
  assertNoSymlinkComponents(targetDir)
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) throw new Error(`restore source is not a regular file: ${sourcePath}`)
  rejectUncheckpointedWal(sourcePath)

  const sourceInfo = validateDatabase(sourcePath)
  const sourceHash = await hashFile(sourcePath)
  const parentDir = dirname(targetDir)
  if (!existsSync(parentDir) || !lstatSync(parentDir).isDirectory()) {
    throw new Error(`restore target parent directory must already exist: ${parentDir}`)
  }

  let createdTargetDir = false
  let createdTargetDb = false
  let tempPath: string | undefined
  try {
    if (existsSync(targetDir)) {
      if (!lstatSync(targetDir).isDirectory()) throw new Error(`restore target is not a directory: ${targetDir}`)
      if (existsSync(targetDbPath)) throw new Error(`restore target database already exists: ${targetDbPath}`)
      if (readdirSync(targetDir).length > 0) throw new Error(`restore target directory must be empty: ${targetDir}`)
    } else {
      mkdirSync(targetDir)
      createdTargetDir = true
    }

    tempPath = join(targetDir, `.governance.db.restore-${process.pid}-${randomUUID()}.tmp`)
    copyFileSync(sourcePath, tempPath, constants.COPYFILE_EXCL)
    const copiedInfo = validateDatabase(tempPath)
    const copiedHash = await hashFile(tempPath)
    rejectUncheckpointedWal(sourcePath)
    if ((await hashFile(sourcePath)) !== sourceHash || copiedHash !== sourceHash) {
      throw new Error('restore source changed while it was being copied; no database was published')
    }
    if (
      copiedInfo.schemaVersion !== sourceInfo.schemaVersion ||
      copiedInfo.totalMemories !== sourceInfo.totalMemories ||
      copiedInfo.tombstones !== sourceInfo.tombstones ||
      copiedInfo.tombstoneDigest !== sourceInfo.tombstoneDigest ||
      copiedInfo.audit.eventCount !== sourceInfo.audit.eventCount ||
      copiedInfo.audit.headHash !== sourceInfo.audit.headHash ||
      !copiedInfo.audit.valid
    ) {
      throw new Error('restored copy does not match the validated source schema, audit chain, or tombstones')
    }
    for (const sidecar of [`${tempPath}-wal`, `${tempPath}-shm`]) rmSync(sidecar, { force: true })
    if (existsSync(targetDbPath)) throw new Error(`restore target database already exists: ${targetDbPath}`)
    linkSync(tempPath, targetDbPath)
    createdTargetDb = true
    unlinkSync(tempPath)
    tempPath = undefined
    return {
      restored: true,
      databasePath: targetDbPath,
      schemaVersion: sourceInfo.schemaVersion,
      memories: sourceInfo.liveMemories,
      tombstones: sourceInfo.tombstones,
      auditEvents: sourceInfo.audit.eventCount,
      auditValid: true,
    }
  } catch (error) {
    if (createdTargetDb) rmSync(targetDbPath, { force: true })
    if (tempPath) {
      rmSync(tempPath, { force: true })
      rmSync(`${tempPath}-wal`, { force: true })
      rmSync(`${tempPath}-shm`, { force: true })
    }
    if (createdTargetDir) {
      try {
        rmdirSync(targetDir)
      } catch {
        // Preserve the original restore error if cleanup cannot remove the empty directory.
      }
    }
    throw error
  }
}
