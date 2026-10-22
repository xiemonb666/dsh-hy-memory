/**
 * Cross-process acceptance: capture in one process, recall in another.
 *
 *   node tests/e2e/cross-session.mjs
 *
 * This is the real E2E-01/02/03/04 evidence: the two operations run in separate
 * `cli` invocations (separate processes), against one data directory, so a
 * recall success cannot be an in-memory artifact.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bundleDir = process.env.HYMEM_BUNDLE_DIR ?? join(process.cwd(), 'dist', 'bundle')
const cli = join(bundleDir, 'cli.js')
const node = process.execPath
const results = []
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: Boolean(ok), detail })
  if (!ok) process.stderr.write(`FAIL ${id} ${name}: ${String(JSON.stringify(detail ?? '')).slice(0, 400)}\n`)
}

function run(args, dataDir) {
  // Automated acceptance stays on the deterministic mock: free, fast, reproducible.
  const result = spawnSync(node, [cli, ...args, '--json', '--engine', 'mock', '--data-dir', dataDir], { encoding: 'utf8', timeout: 180_000 })
  let parsed = null
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    parsed = null
  }
  return { code: result.status, parsed, stdout: result.stdout, stderr: result.stderr }
}

const dataDir = mkdtempSync(join(tmpdir(), 'hymem-cross-'))
try {
  // --- E2E-01: session A writes, session B recalls (different processes) ---
  const captured = run(
    ['capture', '--text', 'Please remember this repo pins CUDA 12.4 and uses pytest for the kernel tests.', '--session', 'session-A'],
    dataDir,
  )
  check('E2E-01a', 'capture in session A creates a governance record', captured.code === 0 && captured.parsed?.created?.length >= 1, captured.parsed ?? captured.stderr)

  const recalled = run(['search', '--query', 'which CUDA version and test runner does this repo use'], dataDir)
  const clue = recalled.parsed?.clues?.[0]
  check(
    'E2E-01b',
    'a separate process recalls the memory from session A',
    recalled.code === 0 && recalled.parsed?.clues?.length >= 1,
    { clues: recalled.parsed?.clues?.length, degraded: recalled.parsed?.degraded },
  )
  check(
    'E2E-01c',
    'the recalled clue carries a real memory id, status and citation',
    Boolean(clue?.memoryId) && typeof clue?.status === 'string' && clue.evidenceCount >= 1,
    clue,
  )
  check(
    'E2E-01d',
    'the injected container is the untrusted-data wrapper',
    typeof recalled.parsed?.rendered === 'string' && recalled.parsed.rendered.startsWith('<memory_clues provenance="untrusted-retrieved-data"'),
    recalled.parsed?.rendered?.slice(0, 160),
  )

  // --- E2E-04: replaying the same capture does not duplicate the record ---
  const before = run(['status'], dataDir)
  const replay = run(
    ['capture', '--text', 'Please remember this repo pins CUDA 12.4 and uses pytest for the kernel tests.', '--session', 'session-A'],
    dataDir,
  )
  const after = run(['status'], dataDir)
  check(
    'E2E-04a',
    'replaying the same capture does not increase the memory count',
    before.parsed?.counts?.total === after.parsed?.counts?.total,
    { before: before.parsed?.counts?.total, after: after.parsed?.counts?.total, replayExit: replay.code },
  )
  const jobs = run(['status'], dataDir)
  check('E2E-04b', 'the audit chain survives the replay', jobs.parsed?.audit?.valid === true, jobs.parsed?.audit)

  // --- E2E-03: a different data directory is a different project (isolation) ---
  const otherDir = mkdtempSync(join(tmpdir(), 'hymem-cross-other-'))
  try {
    const otherSearch = run(['search', '--query', 'which CUDA version and test runner does this repo use'], otherDir)
    check(
      'E2E-03a',
      'a fresh project directory recalls nothing from the first project',
      otherSearch.code === 0 && (otherSearch.parsed?.clues?.length ?? 0) === 0,
      { clues: otherSearch.parsed?.clues?.length },
    )
    const otherStatus = run(['status'], otherDir)
    check(
      'E2E-03b',
      'the isolated store holds zero memories',
      otherStatus.code === 0 && (otherStatus.parsed?.counts?.total ?? -1) === 0,
      otherStatus.parsed?.counts,
    )
  } finally {
    rmSync(otherDir, { recursive: true, force: true })
  }

  // --- E2E-02: a user-stated memory is anchored but never auto-verified ---
  const status = run(['status'], dataDir)
  const counts = status.parsed?.counts ?? {}
  check(
    'E2E-02a',
    'a user-stated memory is stored (supported or needs_review) and never auto-verified',
    (counts.total ?? 0) >= 1 && (counts.verified ?? 0) === 0,
    counts,
  )
  check(
    'E2E-02b',
    'the stored record is scoped to the workspace rather than globally shared',
    clue?.scope === 'workspace',
    { scope: clue?.scope },
  )

  // --- Secret scrubbing end to end: the key must not appear in the database ---
  const hostile = run(
    ['capture', '--text', 'remember my key is sk-live-abcdefghijklmnopqrstuvwxyz012345 for later', '--session', 'session-C'],
    dataDir,
  )
  const dbBytes = existsSync(join(dataDir, 'governance.db')) ? readFileSync(join(dataDir, 'governance.db')) : Buffer.alloc(0)
  const walBytes = existsSync(join(dataDir, 'governance.db-wal')) ? readFileSync(join(dataDir, 'governance.db-wal')) : Buffer.alloc(0)
  const leaked = Buffer.concat([dbBytes, walBytes]).includes(Buffer.from('sk-live-abcdefghijklmnopqrstuvwxyz012345'))
  check('E2E-19', 'a secret in captured text never reaches the governance database', hostile.code === 0 && !leaked, { leaked, exit: hostile.code })
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}

const failed = results.filter(item => !item.ok)
console.log(JSON.stringify({ ok: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)

