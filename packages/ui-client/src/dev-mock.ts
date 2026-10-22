/**
 * FIXTURE MODE ONLY.
 *
 * This module is loaded exclusively when the bundle is built with
 * `VITE_USE_FIXTURES=1` (see `api.ts` → `FIXTURE_MODE` and `vite.config.ts`,
 * which compiles the flag to a literal so a normal production build
 * dead-code-eliminates the dynamic import entirely).
 *
 * Everything below is synthetic sample data for screenshots before the Host API
 * exists. It is never merged into real data, and the shell renders a permanent
 * "Fixture mode" banner while it is active. Do not import this file from
 * production code paths.
 */
import type { RequestOptions } from './api'

const NOW = Date.now()
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString()

const PROJECT_ID = 'project:00000000-0000-7000-8000-000000000001'
const WORKSPACE_ID = 'workspace:00000000-0000-7000-8000-000000000002'
const AGENT_MAIN = 'agent:00000000-0000-7000-8000-0000000000a1'
const AGENT_SUB = 'agent:00000000-0000-7000-8000-0000000000a2'

const MEMORIES = [
  {
    id: 'mem:00000000-0000-7000-8000-000000000101',
    title: 'Deployment target is the staging cluster in eu-west-1',
    content:
      'The project deploys to the staging Kubernetes cluster in eu-west-1. Production is a separate cluster and is only promoted to after the staging smoke suite passes.',
    excerpt:
      'The project deploys to the staging Kubernetes cluster in eu-west-1. Production is a separate cluster and is only promoted to after the staging smoke suite passes.',
    status: 'verified',
    scope: 'project',
    scene: 'coding',
    kind: 'fact',
    sensitivity: 'internal',
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_MAIN,
    evidenceCount: 3,
    version: 4,
    revision: 7,
    createdAt: iso(60 * 24 * 9),
    updatedAt: iso(42),
  },
  {
    id: 'mem:00000000-0000-7000-8000-000000000102',
    title: 'Node runtime is pinned to 24.x across packages',
    content: 'Every workspace package declares engines.node >= 24 and CI runs on Node 24.21.0.',
    status: 'supported',
    scope: 'workspace',
    scene: 'coding',
    kind: 'fact',
    sensitivity: 'internal',
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    evidenceCount: 2,
    version: 2,
    revision: 3,
    createdAt: iso(60 * 24 * 6),
    updatedAt: iso(180),
  },
  {
    id: 'mem:00000000-0000-7000-8000-000000000103',
    title: 'Prefer optimistic concurrency with explicit revisions',
    content:
      'Settings and memory records are saved with an expected revision. A stale revision must fail loudly instead of overwriting another writer.',
    status: 'needs_review',
    scope: 'project',
    scene: 'working',
    kind: 'decision',
    sensitivity: 'internal',
    projectId: PROJECT_ID,
    evidenceCount: 1,
    version: 1,
    revision: 1,
    createdAt: iso(60 * 24 * 2),
    updatedAt: iso(320),
  },
  {
    id: 'mem:00000000-0000-7000-8000-000000000104',
    title: 'Legacy worker used port 48731 for the UI',
    content: 'An older build served the Studio UI on 48731 without a session cookie, which broke framing.',
    status: 'stale',
    scope: 'workspace',
    scene: 'coding',
    kind: 'experience',
    sensitivity: 'internal',
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    evidenceCount: 1,
    version: 3,
    revision: 5,
    createdAt: iso(60 * 24 * 20),
    updatedAt: iso(60 * 24 * 3),
  },
  {
    id: 'mem:00000000-0000-7000-8000-000000000105',
    title: 'Test command for the governance package',
    content: 'Run `pnpm --filter @dsh-hy-memory/governance test` before touching the state machine.',
    status: 'verified',
    scope: 'agent',
    scene: 'coding',
    kind: 'todo',
    sensitivity: 'public',
    projectId: PROJECT_ID,
    agentId: AGENT_SUB,
    evidenceCount: 4,
    version: 2,
    revision: 2,
    createdAt: iso(60 * 24 * 4),
    updatedAt: iso(600),
  },
  {
    id: 'mem:00000000-0000-7000-8000-000000000106',
    title: 'Do not persist raw tool output by default',
    content: 'Raw tool output is metadata-only unless persistRawToolOutput is explicitly enabled.',
    status: 'conflicted',
    scope: 'project',
    scene: 'chat',
    kind: 'preference',
    sensitivity: 'internal',
    projectId: PROJECT_ID,
    evidenceCount: 2,
    version: 2,
    revision: 4,
    createdAt: iso(60 * 24 * 7),
    updatedAt: iso(90),
  },
]

const DIFF = `diff --git a/packages/ui-client/src/api.ts b/packages/ui-client/src/api.ts
index 1a2b3c4..5d6e7f8 100644
--- a/packages/ui-client/src/api.ts
+++ b/packages/ui-client/src/api.ts
@@ -42,7 +42,9 @@ export async function request(path: string, options: RequestOptions = {}) {
   const response = await fetch(url, {
     method,
     credentials: 'include',
+    headers: { 'X-HyMemory-CSRF': csrf },
     signal: controller.signal,
   })
-  if (!response.ok) throw new Error('failed')
+  if (!response.ok) throw new ApiError({ status: response.status })
   return response.json()
 }`

const SETTINGS = {
  version: 1,
  enabled: true,
  backend: 'sdk',
  dataDir: '/fixtures/hymem-data',
  safeMode: true,
  profileScope: 'current',
  models: {
    mode: 'pro',
    extractionEndpointEnv: 'MEMORY_LLM_BASE_URL',
    embeddingEndpointEnv: 'MEMORY_EMBEDDER_BASE_URL',
    externalEgress: 'ask-first',
    localOnly: true,
  },
  capture: {
    enabled: true,
    enableChat: true,
    enableWorking: true,
    enableCoding: true,
    async: true,
    autoCapture: true,
    historicalImport: false,
    secretScrubbing: 'strict',
    evidenceRetentionDays: 90,
    rawTracePolicy: 'metadata-only',
    excludeToolOutputOverKb: 32,
    persistRawToolOutput: false,
    offlineQueueMaxMib: 128,
    maxWriteCostPerDayUsd: 1,
    maxBatchEvents: 60,
  },
  recall: {
    enabled: true,
    mode: 'clue-first',
    trigger: 'task-boundary',
    candidateLimit: 40,
    clueLimit: 4,
    maxInjectionTokens: 600,
    maxSingleClueTokens: 150,
    searchTimeoutMs: 900,
    cacheTtlSeconds: 180,
    allowUnverifiedAsFact: false,
    staleGuidance: 'clue-only',
    skipStaleTechFacts: true,
    fallback: 'no-memory',
  },
  security: {
    denyCrossProjectByDefault: true,
    keyStorage: 'os-keyring-or-0600-env',
    auditLog: true,
    exportConfirmation: true,
    autoPromoteModelClaims: false,
  },
  ui: { enabled: true, locale: 'en', followHostTheme: true, port: 48731, token: '' },
  agents: { defaultScope: 'workspace', sharedMemory: 'explicit-grants-only', concurrency: 2, mergePolicy: 'optimistic-revision' },
}

let settingsRevision = 12

const JOBS = [
  { id: 'job:0001', status: 'received', attempt: 0, createdAt: iso(2), sourceKey: 'sk_1', payloadBytes: 4096 },
  { id: 'job:0002', status: 'extracting', attempt: 1, createdAt: iso(6), sourceKey: 'sk_2', payloadBytes: 8192 },
  { id: 'job:0003', status: 'retryable', attempt: 3, nextRetryAt: iso(-5), errorCode: 'E_BACKEND_TIMEOUT', createdAt: iso(30) },
  { id: 'job:0004', status: 'quarantined', attempt: 2, errorCode: 'E_SECRET_DETECTED', createdAt: iso(120) },
  { id: 'job:0005', status: 'cancelled', attempt: 1, createdAt: iso(240) },
  { id: 'job:0006', status: 'validating', attempt: 1, createdAt: iso(1) },
]

function overview(): unknown {
  const byStatus: Record<string, number> = {}
  for (const job of JOBS) byStatus[job.status] = (byStatus[job.status] ?? 0) + 1
  return {
    counts: {
      total: 128,
      verified: 61,
      needsReview: 9,
      proposed: 4,
      supported: 38,
      conflicted: 3,
      stale: 11,
      superseded: 2,
      rejected: 0,
      deleted: 0,
    },
    health: { stale: 11, conflicted: 3, errors: 2 },
    usage: { recallCount24h: 412, injectedTokens24h: 186_400, skippedQueries24h: 23, errors24h: 2, timeouts24h: 1 },
    trend: {
      retrieval: Array.from({ length: 24 }, (_, index) => ({
        at: iso((23 - index) * 60),
        value: 8 + Math.round(12 * Math.sin(index / 3) + index),
      })),
      capture: Array.from({ length: 24 }, (_, index) => ({
        at: iso((23 - index) * 60),
        value: 3 + Math.round(5 * Math.cos(index / 4) + index / 4),
      })),
    },
    recent: MEMORIES.slice(0, 5),
    jobs: { byStatus, total: JOBS.length, failed24h: 2, oldestQueuedAt: iso(240) },
  }
}

function detail(id: string): unknown {
  const memory = MEMORIES.find(item => item.id === id) ?? MEMORIES[0]!
  return {
    memory: {
      ...memory,
      evidenceIds: ['ev:1', 'ev:2', 'ev:3'],
    },
    claims: [
      {
        id: 'claim:1',
        subject: 'deployment',
        predicate: 'targets',
        object: 'staging-cluster/eu-west-1',
        polarity: 'affirm',
        qualifiers: { environment: 'staging', region: 'eu-west-1' },
        validFrom: iso(60 * 24 * 9),
      },
      {
        id: 'claim:2',
        subject: 'promotion',
        predicate: 'requires',
        object: 'smoke-suite/pass',
        polarity: 'affirm',
        qualifiers: { gate: 'ci' },
      },
    ],
    evidence: [
      {
        id: 'ev:1',
        sourceEventId: 'evt:1',
        type: 'tool_result',
        sha256: 'a3f1c9d2e4b5a6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f',
        trustLevel: 'tool_observed',
        revision: 1,
        verifiedAt: iso(60 * 24 * 9),
        excerpt: 'kubectl config current-context -> staging-eu-west-1',
        createdAt: iso(60 * 24 * 9),
      },
      {
        id: 'ev:2',
        sourceEventId: 'evt:2',
        type: 'test_result',
        sha256: 'b4e2d1c0f9a8b7c6d5e4f302132435465768798a9b0c1d2e3f4051627384950',
        trustLevel: 'test_verified',
        revision: 1,
        excerpt: 'smoke suite: 42 passed, 0 failed',
        createdAt: iso(60 * 24 * 8),
      },
      {
        id: 'ev:3',
        sourceEventId: 'evt:3',
        type: 'git_commit',
        uri: 'git:9f2c1ab',
        sha256: 'c5f3e2d1a0b9c8d7e6f5041324354657687980a9b1c2d3e4f5a6b7c8d9e0f1',
        trustLevel: 'repository_observed',
        revision: 2,
        createdAt: iso(60 * 24 * 7),
      },
    ],
    versions: [
      { version: 4, status: 'verified', createdAt: iso(42), revision: 7, authorPrincipalId: 'owner', note: 'Re-verified after CI' },
      { version: 3, status: 'supported', createdAt: iso(60 * 24 * 2), revision: 5, revertedFrom: 1 },
      { version: 2, status: 'needs_review', createdAt: iso(60 * 24 * 5), revision: 3 },
      { version: 1, status: 'proposed', createdAt: iso(60 * 24 * 9), revision: 1 },
    ],
    bindings: [
      {
        id: 'bind:1',
        memoryId: memory.id,
        workspaceId: WORKSPACE_ID,
        branch: 'main',
        baseCommit: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4',
        headCommit: '9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3',
        filePath: 'packages/ui-client/src/api.ts',
        symbol: 'request',
        patchHash: 'sha256:5f2e1c9d8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1',
        createdAt: iso(60 * 24 * 7),
      },
    ],
    validations: [
      { id: 'val:1', kind: 'test', passed: true, detail: 'smoke suite green', createdAt: iso(60 * 24 * 8) },
      { id: 'val:2', kind: 'schema', passed: true, detail: 'memory record validates', createdAt: iso(42) },
    ],
  }
}

const CONFLICTS = [
  {
    id: 'conflict:1',
    state: 'open',
    projectId: PROJECT_ID,
    older: {
      memoryId: 'mem:00000000-0000-7000-8000-000000000106',
      title: 'Do not persist raw tool output by default',
      claim: { subject: 'raw-tool-output', predicate: 'persistence', object: 'disabled-by-default', polarity: 'affirm', qualifiers: { scope: 'global' } },
      status: 'supported',
      qualifiers: { scope: 'global' },
      evidenceCount: 2,
      updatedAt: iso(60 * 24 * 7),
    },
    newer: {
      memoryId: 'mem:00000000-0000-7000-8000-000000000107',
      title: 'Raw tool output may be persisted when debugging',
      claim: { subject: 'raw-tool-output', predicate: 'persistence', object: 'enabled-for-debug', polarity: 'affirm', qualifiers: { scope: 'debug' } },
      status: 'needs_review',
      qualifiers: { scope: 'debug' },
      evidenceCount: 1,
      updatedAt: iso(90),
    },
    createdAt: iso(88),
    detail: 'Both claims are affirmative but their qualifier scopes disagree.',
  },
  {
    id: 'conflict:2',
    state: 'unresolved',
    projectId: PROJECT_ID,
    older: {
      memoryId: 'mem:00000000-0000-7000-8000-000000000108',
      claim: { subject: 'ui-port', predicate: 'is', object: '48731', polarity: 'affirm', qualifiers: {} },
      status: 'stale',
      evidenceCount: 1,
      updatedAt: iso(60 * 24 * 20),
    },
    newer: {
      memoryId: 'mem:00000000-0000-7000-8000-000000000109',
      claim: { subject: 'ui-port', predicate: 'is', object: '48732', polarity: 'affirm', qualifiers: {} },
      status: 'needs_review',
      evidenceCount: 2,
      updatedAt: iso(200),
    },
    createdAt: iso(190),
  },
]

const AGENTS = [
  {
    id: 'owner',
    name: 'Local Owner',
    kind: 'user',
    role: 'owner',
    projectId: PROJECT_ID,
    lastRecallAt: iso(15),
    sessionCount: 12,
    grantCount: 6,
  },
  {
    id: AGENT_MAIN,
    name: 'main-agent',
    kind: 'agent',
    role: 'main',
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    lastRecallAt: iso(4),
    sessionCount: 9,
    grantCount: 3,
  },
  {
    id: AGENT_SUB,
    name: 'retrieval-subagent',
    kind: 'subagent',
    role: 'subagent',
    parentAgentId: AGENT_MAIN,
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    lastRecallAt: iso(120),
    lastDenialReason: 'cross-project read denied by policy',
    lastDenialAt: iso(140),
    sessionCount: 4,
    grantCount: 1,
  },
]

const GRANTS = [
  { id: 'grant:1', subjectId: AGENT_MAIN, objectScope: PROJECT_ID, action: 'read', issuer: 'owner', revision: 1, createdAt: iso(60 * 24 * 10) },
  { id: 'grant:2', subjectId: AGENT_MAIN, objectScope: PROJECT_ID, action: 'propose', issuer: 'owner', revision: 1, createdAt: iso(60 * 24 * 10) },
  { id: 'grant:3', subjectId: AGENT_SUB, objectScope: WORKSPACE_ID, action: 'read', issuer: 'owner', expiresAt: iso(-60 * 24 * 30), revision: 1, createdAt: iso(60 * 24 * 3) },
]

/** Route a fixture request; paths mirror the Host Studio API exactly. */
export function fixtureRequest(path: string, options: RequestOptions): unknown {
  const [pathname = ''] = path.split('?')
  const method = options.method ?? 'GET'
  const body = (options.body ?? {}) as Record<string, unknown>

  if (pathname === '/api/health') {
    return {
      ok: true,
      plugin: { version: '0.1.0-fixture', enabled: true, dataDir: '/fixtures/hymem-data' },
      worker: { ok: true, engine: 'mock', engineVersion: '2.0.4-fixture', degraded: false, reason: null, queueDepth: 6, mode: 'pro' },
      db: { ok: true, schemaVersion: 1, path: '/fixtures/hymem-data/hymem.db' },
      ui: { version: '0.1.0-fixture', port: 48731 },
      degraded: false,
      reason: null,
      checkedAt: new Date().toISOString(),
    }
  }
  if (pathname === '/api/studio-config') {
    return {
      locale: 'en',
      theme: 'system',
      capabilities: { canCancelJobs: true, canBackup: true, canExport: true, benchmarkUrl: 'https://example.invalid/benchmark' },
    }
  }
  if (pathname === '/api/projects') {
    return {
      items: [
        {
          id: PROJECT_ID,
          name: 'dsh-hy-memory (fixture)',
          workspaces: [{ id: WORKSPACE_ID, name: 'main', rootAlias: 'repo', repoFingerprint: 'sha256:fixture' }],
        },
      ],
      total: 1,
    }
  }
  if (pathname === '/api/overview') return overview()
  if (pathname === '/api/memories') {
    return { items: MEMORIES, total: MEMORIES.length, page: 1, pageSize: 20 }
  }
  if (pathname.startsWith('/api/memories/') && pathname.endsWith('/transition')) {
    return { status: String(body.to ?? 'stale'), revision: 8 }
  }
  if (pathname.startsWith('/api/memories/') && pathname.endsWith('/feedback')) {
    return { ok: true }
  }
  if (pathname.startsWith('/api/memories/')) {
    return detail(decodeURIComponent(pathname.slice('/api/memories/'.length)))
  }
  if (pathname === '/api/conflicts') {
    return { items: CONFLICTS, total: CONFLICTS.length }
  }
  if (pathname.startsWith('/api/conflicts/') && pathname.endsWith('/resolve')) {
    const resolution = String(body.resolution ?? 'keep_both')
    return {
      result: {
        olderStatus: resolution === 'supersede' || resolution === 'reject' ? 'superseded' : 'supported',
        newerStatus: resolution === 'reject' ? 'rejected' : 'needs_review',
        state: `resolved_${resolution === 'request_verification' || resolution === 'leave_unresolved' ? 'keep_both' : resolution}`,
        auditEventId: 'audit:fixture-1',
      },
    }
  }
  if (pathname === '/api/agents') return { items: AGENTS, total: AGENTS.length }
  if (pathname === '/api/grants') {
    if (method === 'POST') {
      return { id: `grant:${GRANTS.length + 1}`, ...body, issuer: 'owner', revision: 1, createdAt: new Date().toISOString() }
    }
    return { items: GRANTS, total: GRANTS.length }
  }
  if (pathname.startsWith('/api/grants/')) return { ok: true }
  if (pathname === '/api/jobs') {
    return { items: JOBS, total: JOBS.length }
  }
  if (pathname.startsWith('/api/jobs/')) return { ok: true }
  if (pathname === '/api/usage') {
    return {
      recallCount: 4120,
      injectedTokens: 1_864_000,
      skippedQueries: 230,
      errors: 12,
      timeouts: 5,
      cacheHitRate: 0.62,
      windowHours: 24,
      perAgent: [
        { agentId: AGENT_MAIN, name: 'main-agent', recallCount: 3100, injectedTokens: 1_402_000, skippedQueries: 180, errors: 9 },
        { agentId: AGENT_SUB, name: 'retrieval-subagent', recallCount: 1020, injectedTokens: 462_000, skippedQueries: 50, errors: 3 },
      ],
      quality: {
        verifiedRatio: 0.48,
        staleRatio: 0.086,
        conflictRate: 0.023,
        evidenceCoverage: 0.91,
        retrievalPrecision: 0.74,
        feedbackUseful: 61,
        feedbackIncorrect: 7,
        feedbackStale: 4,
      },
      cost: { estimatedUsd: null, ratePer1kTokensUsd: null, rateKnown: false },
      benchmarkUrl: 'https://example.invalid/benchmark',
    }
  }
  if (pathname === '/api/settings') {
    if (method === 'PUT') {
      const expected = Number(body.expectedRevision ?? settingsRevision)
      if (expected !== settingsRevision) {
        return { error: { code: 'E_REVISION_MISMATCH', message: 'Settings changed since you loaded them.' } }
      }
      settingsRevision += 1
      return { settings: SETTINGS, revision: settingsRevision }
    }
    return { settings: SETTINGS, revision: settingsRevision }
  }
  if (pathname === '/api/diagnostics') {
    return {
      versions: {
        dsh: '0.2.1-rc.2',
        plugin: '0.1.0-fixture',
        worker: '2.0.4-fixture',
        ui: '0.1.0-fixture',
        profile: 'default',
        node: '24.21.0',
        python: '3.13.2',
      },
      dependencies: [
        { name: 'hy-memory', ok: true, version: '2.0.4', required: true },
        { name: 'sqlite', ok: true, version: 'node:sqlite' },
        { name: 'git', ok: true, version: '2.47.1' },
        { name: 'embedding-endpoint', ok: false, detail: 'not configured (fixture)', required: false },
      ],
      paths: {
        dataDir: '/fixtures/hymem-data',
        db: '/fixtures/hymem-data/hymem.db',
        logs: '/fixtures/hymem-data/logs',
        artifacts: '/fixtures/hymem-data/artifacts',
        backup: '/fixtures/hymem-data/backups',
      },
      audit: { ok: true, length: 1284, headHash: 'sha256:9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0', verifiedAt: iso(5), brokenAt: null },
      permissionMatrix: [
        { role: 'owner', scopes: ['project', 'workspace', 'shared'], actions: ['read', 'propose', 'review', 'feedback', 'delete', 'admin'] },
        { role: 'main', scopes: ['workspace'], actions: ['read', 'propose', 'feedback'] },
        { role: 'subagent', scopes: ['workspace'], actions: ['read'] },
      ],
      logDownloadUrl: '/api/diagnostics/logs',
      profileName: 'default',
      worker: { ok: true, engine: 'mock', engineVersion: '2.0.4-fixture', degraded: false, reason: null, queueDepth: 6 },
      redaction: { secrets: 3, events: 812, skipped: 2 },
    }
  }
  if (pathname === '/api/events') {
    return {
      items: [
        { id: 'audit:1', at: iso(5), actor: 'owner', action: 'memory.transition', objectType: 'memory', objectId: 'mem:...101', outcome: 'ok' },
        { id: 'audit:2', at: iso(12), actor: AGENT_MAIN, action: 'recall.query', objectType: 'session', objectId: 'sess:1', outcome: 'ok' },
        { id: 'audit:3', at: iso(30), actor: AGENT_SUB, action: 'grant.denied', objectType: 'project', objectId: PROJECT_ID, outcome: 'denied' },
      ],
      total: 3,
    }
  }
  if (pathname.startsWith('/api/code/')) {
    return {
      bindings: [
        {
          id: 'bind:1',
          memoryId: decodeURIComponent(pathname.slice('/api/code/'.length)),
          workspaceId: WORKSPACE_ID,
          branch: 'main',
          baseCommit: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4',
          headCommit: '9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3',
          filePath: 'packages/ui-client/src/api.ts',
          symbol: 'request',
          patchHash: 'sha256:5f2e1c9d8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1',
          createdAt: iso(60 * 24 * 7),
        },
      ],
      diffs: [{ path: 'packages/ui-client/src/api.ts', patch: DIFF }],
      tests: [
        { id: 'test:1', commit: '9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3', exitCode: 0, environment: 'node-24.21.0 / windows', command: 'pnpm test', ranAt: iso(60 * 24 * 7), passed: true, suite: 'governance' },
        { id: 'test:2', commit: '9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3', exitCode: 1, environment: 'node-24.21.0 / linux', command: 'pnpm test', ranAt: iso(60 * 24 * 7 + 30), passed: false, suite: 'retrieval' },
        { id: 'test:3', commit: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4', exitCode: null, environment: 'unknown', ranAt: iso(60 * 24 * 9) },
      ],
      freshness: { stale: false, checkedAt: iso(10), headCommit: '9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3', baseCommit: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4', dirty: false },
    }
  }
  if (pathname === '/api/backup') {
    return { path: '/fixtures/hymem-data/backups/hymem-fixture.db', sha256: 'sha256:fixture-backup', bytes: 1_048_576, createdAt: new Date().toISOString() }
  }

  return { error: { code: 'E_NOT_FOUND', message: `Fixture mode has no data for ${pathname}` } }
}