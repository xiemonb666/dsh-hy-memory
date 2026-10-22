/**
 * SQLite persistence for the governance layer. Node's built-in `node:sqlite`
 * (Node >= 24) provides FTS5 and WAL without a native dependency.
 *
 * The database is the authoritative store for memory identity, evidence,
 * permissions, state transitions, conflicts, jobs, injections and audit. The
 * Hy-Memory engine stores derived vectors and text; its ids are never used as
 * governance ids.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_SETTINGS, canonicalJson, sha256 } from '@dsh-hy-memory/contracts'

export const SCHEMA_VERSION = 1

const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo_fingerprint TEXT NOT NULL,
  root_alias TEXT NOT NULL,
  remote TEXT,
  visibility TEXT NOT NULL DEFAULT 'internal',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, repo_fingerprint)
);

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent',
  owner_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  agent_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  parent_agent_id TEXT,
  project_id TEXT NOT NULL,
  workspace_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_session ON agent_sessions(session_id);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  object_scope TEXT NOT NULL,
  action TEXT NOT NULL,
  project_id TEXT,
  workspace_id TEXT,
  expires_at TEXT,
  issuer TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(subject_id, object_scope, action)
);
CREATE INDEX IF NOT EXISTS idx_grants_subject ON grants(subject_id, revoked_at);

CREATE TABLE IF NOT EXISTS source_events (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL,
  checksum TEXT NOT NULL,
  event_type TEXT NOT NULL,
  redacted_payload TEXT NOT NULL,
  session_id TEXT,
  workspace_id TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_key, checksum)
);
CREATE INDEX IF NOT EXISTS idx_source_events_key ON source_events(source_key);

CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL REFERENCES source_events(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  uri TEXT,
  sha256 TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  verified_at TEXT,
  retention_days INTEGER,
  excerpt TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_source ON evidence_items(source_event_id);

CREATE TABLE IF NOT EXISTS memory_records (
  id TEXT PRIMARY KEY,
  engine_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  scene TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  canonical_text TEXT NOT NULL,
  status TEXT NOT NULL,
  scope TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workspace_id TEXT,
  agent_id TEXT,
  author_id TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  confidence REAL,
  valid_from TEXT,
  valid_until TEXT,
  content_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  tombstone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_records(project_id, workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_records(status);
CREATE INDEX IF NOT EXISTS idx_memory_hash ON memory_records(content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED,
  title,
  content,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_records BEGIN
  INSERT INTO memory_fts(memory_id, title, content) VALUES (new.id, new.title, new.canonical_text);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE OF title, canonical_text ON memory_records BEGIN
  DELETE FROM memory_fts WHERE memory_id = old.id;
  INSERT INTO memory_fts(memory_id, title, content) VALUES (new.id, new.title, new.canonical_text);
END;

CREATE TABLE IF NOT EXISTS memory_evidence (
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence_items(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  extract_span TEXT,
  claim_hash TEXT,
  PRIMARY KEY(memory_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  parent_version INTEGER,
  content_hash TEXT NOT NULL,
  change_reason TEXT NOT NULL,
  supersedes_id TEXT,
  actor_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_memory ON memory_versions(memory_id, created_at);

CREATE TABLE IF NOT EXISTS memory_claims (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  polarity TEXT NOT NULL,
  qualifiers_json TEXT NOT NULL,
  valid_from TEXT,
  valid_until TEXT,
  claim_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_key ON memory_claims(claim_key);

CREATE TABLE IF NOT EXISTS conflict_cases (
  id TEXT PRIMARY KEY,
  left_claim_id TEXT NOT NULL,
  right_claim_id TEXT NOT NULL,
  left_memory_id TEXT NOT NULL,
  right_memory_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL,
  resolution TEXT,
  resolver TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conflicts_state ON conflict_cases(state);

CREATE TABLE IF NOT EXISTS code_bindings (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  branch TEXT,
  base_commit TEXT,
  head_commit TEXT,
  file_path TEXT,
  symbol TEXT,
  signature_hash TEXT,
  patch_hash TEXT,
  chain_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bindings_memory ON code_bindings(memory_id);

CREATE TABLE IF NOT EXISTS memory_validations (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  validator TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  result TEXT NOT NULL,
  tested_commit TEXT,
  evidence_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capture_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  error_code TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON capture_jobs(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON capture_jobs(lease_expires_at);

CREATE TABLE IF NOT EXISTS injection_receipts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  principal_id TEXT NOT NULL,
  ids_json TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  reason TEXT NOT NULL,
  redaction_version INTEGER NOT NULL DEFAULT 1,
  elapsed_ms INTEGER NOT NULL,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  acl_revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_session ON injection_receipts(session_id, created_at);

CREATE TABLE IF NOT EXISTS usage_metrics (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  agent_id TEXT,
  operation TEXT NOT NULL,
  token_est INTEGER NOT NULL DEFAULT 0,
  llm_cost_est REAL,
  recall_ms INTEGER,
  hit_ids TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  operation TEXT NOT NULL,
  target TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  prev_hash TEXT,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tombstones (
  memory_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_state (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT,
  acl_revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
`

export interface OpenOptions {
  readonly path: string
  readonly seedSettings?: boolean
}

/**
 * Open (and migrate) a governance database.
 * @param options - database file path and seeding behavior.
 * @returns an open database handle with migrations applied.
 */
export function openDatabase(options: OpenOptions): DatabaseSync {
  if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true })
  const db = new DatabaseSync(options.path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(MIGRATION_V1)
  const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(SCHEMA_VERSION) as
    | { version: number }
    | undefined
  if (!applied) {
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, new Date().toISOString())
  }
  if (options.seedSettings !== false) {
    const row = db.prepare('SELECT key FROM settings WHERE key = ?').get('plugin') as { key: string } | undefined
    if (!row) {
      db.prepare('INSERT INTO settings(key, value, revision, updated_at) VALUES (?, ?, ?, ?)').run(
        'plugin',
        canonicalJson(DEFAULT_SETTINGS),
        1,
        new Date().toISOString(),
      )
    }
  }
  return db
}

/**
 * Run a synchronous transaction. Any throw rolls back.
 * @param db - open database.
 * @param fn - transaction body.
 * @returns the body's result.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Rollback failure is secondary; surface the original error.
    }
    throw error
  }
}

/** Stable hash of a row's mutable content used for version chains. */
export function memoryContentHash(title: string, text: string): string {
  return sha256(`${title}\u0000${text}`)
}