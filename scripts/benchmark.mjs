/**
 * Offline benchmark: measures the real cost of the retrieval and governance
 * paths on this machine. No LLM is called; every number printed here comes from
 * a timed run in this process.
 *
 *   node scripts/benchmark.mjs [--count 10000]
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { GovernanceStore } from '../packages/governance/src/index.ts'
import { RetrievalController } from '../packages/retrieval/src/index.ts'
import { DEFAULT_SETTINGS, estimateTokens } from '../packages/contracts/src/index.ts'

const countArg = process.argv.indexOf('--count')
const total = countArg >= 0 ? Number(process.argv[countArg + 1]) : 10_000
const dir = mkdtempSync(join(tmpdir(), 'hymem-bench-'))
const store = new GovernanceStore(join(dir, 'governance.db'))
store.ensureProject('proj-bench', 'Benchmark')
store.ensureWorkspace({ id: 'ws-bench', projectId: 'proj-bench', repoFingerprint: 'bench', rootAlias: 'C:/bench' })
store.ensureOwner()

const words = ['matcher', 'neighbor', 'cuda', 'kernel', 'pytest', 'boundary', 'regression', 'cache', 'vector', 'commit']
const insert = store.db.prepare(
  `INSERT INTO memory_records(id, version, scene, kind, title, canonical_text, status, scope, project_id, workspace_id,
     author_id, sensitivity, content_hash, revision, created_at, updated_at, tombstone)
   VALUES (?, 1, ?, ?, ?, ?, ?, 'workspace', 'proj-bench', 'ws-bench', 'agent-main', 'internal', ?, 0, ?, ?, 0)`,
)
const now = new Date().toISOString()
const statuses = ['supported', 'verified', 'needs_review', 'proposed', 'stale', 'conflicted']
const scenes = ['chat', 'working', 'coding']

const seedStart = performance.now()
store.db.exec('BEGIN')
for (let index = 0; index < total; index++) {
  const word = words[index % words.length]
  const status = statuses[index % statuses.length]
  const scene = scenes[index % scenes.length]
  const text = `the ${word} path handles case ${index} with a ${words[(index * 7) % words.length]} guard`
  insert.run(
    `01a20000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    scene,
    index % 3 === 0 ? 'decision' : 'fact',
    `${word} note ${index}`,
    text,
    status,
    `hash-${index}`,
    now,
    now,
  )
}
store.db.exec('COMMIT')
const seedMs = performance.now() - seedStart

const samples = []
const source = {
  keyword: async query => {
    const page = store.listMemories({ projectId: query.projectId, query: query.query, limit: query.limit })
    return page.items.map((memory, index) => ({ memoryId: memory.id, score: 1 - index / Math.max(page.items.length, 1), via: 'keyword' }))
  },
  semantic: async () => [],
}
const controller = new RetrievalController({ store, source, settings: DEFAULT_SETTINGS.recall })

const queries = [
  'matcher neighbor boundary',
  'cuda kernel regression',
  'pytest cache vector',
  'commit matcher guard',
  'boundary case 42',
]
for (let round = 0; round < 40; round++) {
  const query = queries[round % queries.length]
  const started = performance.now()
  const outcome = await controller.search({
    query,
    mode: 'hybrid',
    projectId: 'proj-bench',
    workspaceId: 'ws-bench',
    agentId: 'agent-bench',
    principalId: 'owner',
    sessionId: `s-${round}`,
    limit: 40,
    semantic: false,
  })
  samples.push({
    ms: performance.now() - started,
    clues: outcome.clues.length,
    tokens: outcome.tokenCount,
    budget: DEFAULT_SETTINGS.recall.maxInjectionTokens,
  })
}

const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b)
const percentile = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
const pageStart = performance.now()
const page = store.listMemories({ projectId: 'proj-bench', limit: 20, offset: 5000 })
const pageMs = performance.now() - pageStart
const ftsStart = performance.now()
const fts = store.listMemories({ projectId: 'proj-bench', query: 'matcher neighbor', limit: 20 })
const ftsMs = performance.now() - ftsStart
const overviewStart = performance.now()
store.overview('proj-bench')
const overviewMs = performance.now() - overviewStart

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: process.env.PROCESSOR_IDENTIFIER ?? 'unknown',
  },
  dataset: { memories: total, projects: 1, statuses: statuses.length, scenes: scenes.length },
  seedMs: Number(seedMs.toFixed(1)),
  retrieval: {
    samples: samples.length,
    p50Ms: Number(percentile(0.5).toFixed(2)),
    p95Ms: Number(percentile(0.95).toFixed(2)),
    maxMs: Number(Math.max(...sorted).toFixed(2)),
    meanClues: Number((samples.reduce((sum, item) => sum + item.clues, 0) / samples.length).toFixed(2)),
    meanTokens: Number((samples.reduce((sum, item) => sum + item.tokens, 0) / samples.length).toFixed(1)),
    maxTokens: Math.max(...samples.map(item => item.tokens)),
    budget: DEFAULT_SETTINGS.recall.maxInjectionTokens,
    budgetViolations: samples.filter(item => item.tokens > item.budget).length,
  },
  paging: { offset: 5000, limit: 20, total: page.total, ms: Number(pageMs.toFixed(2)) },
  fts: { query: 'matcher neighbor', hits: fts.total, ms: Number(ftsMs.toFixed(2)) },
  overview: { ms: Number(overviewMs.toFixed(2)) },
  tokenEstimate: {
    sampleClue: estimateTokens('[01a20000-0000-7000-8000-000000000001][SUPPORTED][applies_to: workspace:ws-bench] evidence=0'),
  },
  notes: [
    'Keyword channel only: no embedding endpoint is configured on this machine.',
    'No LLM A/B benchmark was run; the optimization gate is BLOCKED, not passed.',
    'Numbers are single-machine and single-process; they are not a vendor claim.',
  ],
}

store.close()
rmSync(dir, { recursive: true, force: true })

// A benchmark that returns nothing measures nothing. Fail loudly instead of
// publishing a fast p50 over zero clues: that is exactly how a broken keyword
// channel once produced a "0.09 ms" result with meanClues 0.
const emptyRuns = samples.filter(sample => sample.clues === 0).length
if (emptyRuns === samples.length) {
  console.error(
    `benchmark: all ${samples.length} retrieval samples returned zero clues; ` +
      'the pipeline is degraded and these timings are meaningless',
  )
  process.exit(1)
}
if (emptyRuns > 0) {
  console.error(`benchmark: ${emptyRuns}/${samples.length} samples returned zero clues (partial degradation)`)
}

mkdirSync('artifacts', { recursive: true })
writeFileSync(join('artifacts', 'benchmark-offline.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
