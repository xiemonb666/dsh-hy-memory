/**
 * Host plugin configuration with fail-loud validation.
 *
 * The DSH loader passes the row's `config` object; this module normalizes it
 * and throws on invalid values instead of silently defaulting. Defaults are
 * conservative: capture on, auto-recall on but tool-only fallback available,
 * loopback-only worker and UI.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export interface HostConfig {
  enabled: boolean
  dataDir: string
  worker: {
    url: string | null
    token: string | null
    python: string
    port: number
    autoSpawn: boolean
    engine: 'auto' | 'mock' | 'hy'
    startupTimeoutMs: number
    requestTimeoutMs: number
  }
  ui: {
    enabled: boolean
    host: string
    port: number
    token: string | null
    allowedFrameOrigins: string[]
  }
  recall: {
    enabled: boolean
    mode: 'clue-first' | 'tool-only'
    trigger: 'task-boundary' | 'every-step'
    candidateLimit: number
    clueLimit: number
    maxInjectionTokens: number
    maxSingleClueTokens: number
    searchTimeoutMs: number
    cacheTtlSeconds: number
    allowUnverifiedAsFact: boolean
    staleGuidance: 'clue-only' | 'hide'
    skipStaleTechFacts: boolean
  }
  capture: {
    enabled: boolean
    enableChat: boolean
    enableWorking: boolean
    enableCoding: boolean
    autoCapture: boolean
    historicalImport: boolean
    secretScrubbing: 'strict' | 'off'
    evidenceRetentionDays: number
    excludeToolOutputOverKb: number
    persistRawToolOutput: boolean
    offlineQueueMaxMib: number
    maxBatchEvents: number
  }
  security: {
    denyCrossProjectByDefault: boolean
    auditLog: boolean
    exportConfirmation: boolean
  }
  agents: {
    concurrency: number
    defaultScope: 'private' | 'agent' | 'workspace' | 'project' | 'shared'
  }
}

function pickBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`hymem config: ${field} must be a boolean`)
  return value
}

function pickNumber(value: unknown, fallback: number, field: string, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`hymem config: ${field} must be a number in [${min}, ${max}]`)
  }
  return value
}

function pickString(value: unknown, fallback: string, field: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length === 0) throw new Error(`hymem config: ${field} must be a non-empty string`)
  return value
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`hymem config: ${field} must be an object`)
  return value as Record<string, unknown>
}

/**
 * Default data directory for the current platform. Windows uses LOCALAPPDATA,
 * other platforms XDG data home, and `HYMEM_DATA_DIR` always wins.
 * @returns absolute directory path.
 */
export function defaultDataDir(): string {
  const fromEnv = process.env.HYMEM_DATA_DIR
  if (fromEnv) return fromEnv
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    return local ? join(local, 'dsh-hy-memory') : join(homedir(), 'AppData', 'Local', 'dsh-hy-memory')
  }
  const xdg = process.env.XDG_DATA_HOME
  return xdg ? join(xdg, 'dsh-hy-memory') : join(homedir(), '.local', 'share', 'dsh-hy-memory')
}

/**
 * Normalize the loader-supplied config into a complete {@link HostConfig}.
 * @param raw - the row config from cordis.patch.yml (may be undefined).
 * @returns a validated configuration with all defaults applied.
 */
export function normalizeConfig(raw: unknown): HostConfig {
  const root = asRecord(raw, 'config')
  const worker = asRecord(root.worker, 'worker')
  const ui = asRecord(root.ui, 'ui')
  const recall = asRecord(root.recall, 'recall')
  const capture = asRecord(root.capture, 'capture')
  const security = asRecord(root.security, 'security')
  const agents = asRecord(root.agents, 'agents')
  const dataDir = pickString(root.dataDir, defaultDataDir(), 'dataDir')
  mkdirSync(dataDir, { recursive: true })
  const frameOrigins = Array.isArray(ui.allowedFrameOrigins)
    ? (ui.allowedFrameOrigins as unknown[]).filter((item): item is string => typeof item === 'string')
    : [
        'dsh-app://app',
        process.env.DSH_WEB_URL ?? 'http://127.0.0.1:58094',
        'http://localhost:58094',
        'http://127.0.0.1:58231',
        'http://localhost:58231',
      ]
  return {
    enabled: pickBoolean(root.enabled, true, 'enabled'),
    dataDir,
    worker: {
      url: typeof worker.url === 'string' && worker.url.length > 0 ? worker.url : null,
      token: typeof worker.token === 'string' && worker.token.length > 0 ? worker.token : null,
      python: pickString(worker.python, process.env.HYMEM_PYTHON ?? 'python', 'worker.python'),
      port: pickNumber(worker.port, 0, 'worker.port', 0, 65535),
      autoSpawn: pickBoolean(worker.autoSpawn, true, 'worker.autoSpawn'),
      engine: ((): HostConfig['worker']['engine'] => {
        const value = worker.engine
        if (value === undefined) return 'auto'
        if (value === 'auto' || value === 'mock' || value === 'hy') return value
        throw new Error('hymem config: worker.engine must be auto|mock|hy')
      })(),
      startupTimeoutMs: pickNumber(worker.startupTimeoutMs, 20_000, 'worker.startupTimeoutMs', 1000, 120_000),
      requestTimeoutMs: pickNumber(worker.requestTimeoutMs, 30_000, 'worker.requestTimeoutMs', 1000, 300_000),
    },
    ui: {
      enabled: pickBoolean(ui.enabled, true, 'ui.enabled'),
      host: pickString(ui.host, '127.0.0.1', 'ui.host'),
      port: pickNumber(ui.port, 48731, 'ui.port', 1024, 65535),
      token: typeof ui.token === 'string' && ui.token.length > 0 ? ui.token : null,
      allowedFrameOrigins: frameOrigins,
    },
    recall: {
      enabled: pickBoolean(recall.enabled, true, 'recall.enabled'),
      mode: recall.mode === 'tool-only' ? 'tool-only' : 'clue-first',
      trigger: recall.trigger === 'every-step' ? 'every-step' : 'task-boundary',
      candidateLimit: pickNumber(recall.candidateLimit, 40, 'recall.candidateLimit', 1, 200),
      clueLimit: pickNumber(recall.clueLimit, 4, 'recall.clueLimit', 0, 10),
      maxInjectionTokens: pickNumber(recall.maxInjectionTokens, 600, 'recall.maxInjectionTokens', 0, 4000),
      maxSingleClueTokens: pickNumber(recall.maxSingleClueTokens, 150, 'recall.maxSingleClueTokens', 20, 1000),
      searchTimeoutMs: pickNumber(recall.searchTimeoutMs, 2500, 'recall.searchTimeoutMs', 50, 30_000),
      cacheTtlSeconds: pickNumber(recall.cacheTtlSeconds, 180, 'recall.cacheTtlSeconds', 0, 3600),
      allowUnverifiedAsFact: pickBoolean(recall.allowUnverifiedAsFact, false, 'recall.allowUnverifiedAsFact'),
      staleGuidance: recall.staleGuidance === 'hide' ? 'hide' : 'clue-only',
      skipStaleTechFacts: pickBoolean(recall.skipStaleTechFacts, true, 'recall.skipStaleTechFacts'),
    },
    capture: {
      enabled: pickBoolean(capture.enabled, true, 'capture.enabled'),
      enableChat: pickBoolean(capture.enableChat, true, 'capture.enableChat'),
      enableWorking: pickBoolean(capture.enableWorking, true, 'capture.enableWorking'),
      enableCoding: pickBoolean(capture.enableCoding, true, 'capture.enableCoding'),
      autoCapture: pickBoolean(capture.autoCapture, true, 'capture.autoCapture'),
      historicalImport: pickBoolean(capture.historicalImport, false, 'capture.historicalImport'),
      secretScrubbing: capture.secretScrubbing === 'off' ? 'off' : 'strict',
      evidenceRetentionDays: pickNumber(capture.evidenceRetentionDays, 90, 'capture.evidenceRetentionDays', 1, 3650),
      excludeToolOutputOverKb: pickNumber(capture.excludeToolOutputOverKb, 32, 'capture.excludeToolOutputOverKb', 1, 1024),
      persistRawToolOutput: pickBoolean(capture.persistRawToolOutput, false, 'capture.persistRawToolOutput'),
      offlineQueueMaxMib: pickNumber(capture.offlineQueueMaxMib, 128, 'capture.offlineQueueMaxMib', 1, 4096),
      maxBatchEvents: pickNumber(capture.maxBatchEvents, 60, 'capture.maxBatchEvents', 1, 500),
    },
    security: {
      denyCrossProjectByDefault: pickBoolean(security.denyCrossProjectByDefault, true, 'security.denyCrossProjectByDefault'),
      auditLog: pickBoolean(security.auditLog, true, 'security.auditLog'),
      exportConfirmation: pickBoolean(security.exportConfirmation, true, 'security.exportConfirmation'),
    },
    agents: {
      concurrency: pickNumber(agents.concurrency, 2, 'agents.concurrency', 1, 16),
      defaultScope: ((): HostConfig['agents']['defaultScope'] => {
        const value = agents.defaultScope
        if (value === undefined) return 'workspace'
        if (value === 'private' || value === 'agent' || value === 'workspace' || value === 'project' || value === 'shared') return value
        throw new Error('hymem config: agents.defaultScope is invalid')
      })(),
    },
  }
}
