import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type RequestListener, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyModelRequestLimits,
  configurationHash,
  createIsolatedEnv,
  loadSafeSourceControls,
  makeBalancedPairOrder,
  normalizeUsage,
  parseModelEnv,
  providerUsageFromMetrics,
  resolveTestPaths,
  runCommand,
  requestChatCompletion,
  scoreAnswer,
  safeEffectiveModelConfig,
  serializeModelEnv,
  startIsolatedWorker,
  stopOwnedChild,
  validateModelEnv,
  writeJsonReport,
  // @ts-expect-error Runtime MJS helpers are imported directly by Vitest.
} from '../../scripts/online-test-support.mjs'

const MODEL_ENV = {
  MEMORY_LLM_BASE_URL: 'https://chat.example.test/v1',
  MEMORY_LLM_MODEL: 'chat-model',
  MEMORY_LLM_API_KEY: 'test-chat-secret',
  MEMORY_EMBEDDER_BASE_URL: 'http://127.0.0.1:9001/v1',
  MEMORY_EMBEDDER_MODEL: 'embed-model',
  MEMORY_EMBEDDER_API_KEY: 'test-embed-secret',
  MEMORY_EMBEDDING_DIMS: '1024',
  MEMORY_LLM_EXTRA_BODY: '{"enable_thinking":false}',
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return `http://127.0.0.1:${address.port}/v1`
}

describe('online test support', () => {
  it('loads only approved model parameters and preserves equals signs in values', () => {
    const parsed = parseModelEnv([
      '# model config',
      'MEMORY_LLM_BASE_URL=https://chat.example.test/v1',
      'MEMORY_LLM_API_KEY = token=with=equals',
      'MEMORY_LLM_EXTRA_BODY={"enable_thinking":false}',
      'MEMORY_DATA_DIR=C:/real-user-data',
      'MEMORY_HISTORY_ENABLE=1',
      'OPENAI_API_KEY=must-not-inherit',
      'HYMEM_MODEL_POLICY={"externalEgress":"allow-configured"}',
    ].join('\n'))

    expect(parsed).toEqual({
      MEMORY_LLM_BASE_URL: 'https://chat.example.test/v1',
      MEMORY_LLM_API_KEY: 'token=with=equals',
      MEMORY_LLM_EXTRA_BODY: '{"enable_thinking":false}',
    })
    expect(serializeModelEnv(parsed)).not.toContain('real-user-data')
    expect(serializeModelEnv(parsed)).not.toContain('OPENAI_API_KEY')
  })

  it('records only explicit non-sensitive source behavior flags for run comparison', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hymem-safe-source-flags-'))
    const path = join(directory, 'source.env')
    try {
      writeFileSync(path, [
        'MEMORY_CODING_ENABLED=1',
        'MEMORY_HISTORY_ENABLE=0',
        'MEMORY_METRICS=0',
        'MEMORY_LLM_API_KEY=never-report-this-secret',
        'UNRELATED_SETTING=private-value',
      ].join('\n'))
      const controls = loadSafeSourceControls(path)
      expect(controls).toEqual({
        MEMORY_CODING_ENABLED: '1',
        MEMORY_HISTORY_ENABLE: '0',
        MEMORY_METRICS: '0',
      })
      expect(JSON.stringify(controls)).not.toContain('never-report-this-secret')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects incomplete or unsafe model configuration without echoing credentials', () => {
    expect(() => validateModelEnv({})).toThrow(/required/)
    expect(() => validateModelEnv({
      ...MODEL_ENV,
      MEMORY_LLM_BASE_URL: 'file:///private/key',
    })).toThrow(/HTTP\(S\)/)
    expect(() => validateModelEnv({
      ...MODEL_ENV,
      MEMORY_LLM_EXTRA_BODY: '{"model":"override"}',
    })).toThrow(/reserved/)
    expect(() => validateModelEnv({
      ...MODEL_ENV,
      MEMORY_EMBEDDING_DIMS: 'not-a-number',
    })).toThrow(/embedding dimension/)
  })

  it('builds an isolated child environment and pins model data away from inherited paths', () => {
    const env = createIsolatedEnv(
      {
        PATH: 'C:/safe/bin',
        SystemRoot: 'C:/Windows',
        OPENAI_API_KEY: 'ambient-secret',
        MEMORY_DATA_DIR: 'C:/real-user-data',
        MEMORY_LLM_API_KEY: 'ambient-model-secret',
        HYMEM_PROFILE: 'existing-profile',
        HYMEM_DATA_DIR: 'C:/existing-hymem-data',
        PYTHONPATH: 'C:/unexpected/python',
      },
      MODEL_ENV,
      {
        dataDir: 'C:/tmp/hymem-online/data',
        bundleDir: 'C:/repo/artifacts/validation/bundle',
        pythonPath: 'C:/repo/.venv/Scripts/python.exe',
      },
    )

    expect(env.PATH).toBe('C:/safe/bin')
    expect(env.SystemRoot).toBe('C:/Windows')
    expect(env.HYMEM_DATA_DIR).toBe('C:/tmp/hymem-online/data')
    expect(env.HYMEM_BUNDLE_DIR).toBe('C:/repo/artifacts/validation/bundle')
    expect(env.HYMEM_PYTHON).toBe('C:/repo/.venv/Scripts/python.exe')
    expect(env.MEMORY_LLM_API_KEY).toBe(MODEL_ENV.MEMORY_LLM_API_KEY)
    expect(env.MEMORY_DATA_DIR).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.HYMEM_PROFILE).toBeUndefined()
    expect(env.PYTHONPATH).toBeUndefined()
  })

  it('hashes effective config without exposing values and makes a deterministic balanced schedule', () => {
    const hash = configurationHash(MODEL_ENV)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(hash).not.toContain(MODEL_ENV.MEMORY_LLM_API_KEY)
    expect(configurationHash({ ...MODEL_ENV })).toBe(hash)
    expect(configurationHash({ ...MODEL_ENV, MEMORY_LLM_API_KEY: 'different-secret' })).not.toBe(hash)

    const first = makeBalancedPairOrder(42) as string[][]
    expect(first).toEqual(makeBalancedPairOrder(42))
    expect(first).toHaveLength(3)
    expect(first.flat()).toHaveLength(6)
    expect(first.flat().filter(arm => arm === 'noMemory')).toHaveLength(3)
    expect(first.flat().filter(arm => arm === 'withRecall')).toHaveLength(3)
    expect(first.filter(pair => pair[0] === 'noMemory')).toHaveLength(2)
  })

  it('uses explicit portable Node and Python runtime overrides', () => {
    const paths = resolveTestPaths('C:/repo', {
      HYMEM_BUNDLE_DIR: 'C:/repo/artifacts/bundle',
      HYMEM_TEST_NODE: 'C:/tools/node.exe',
      HYMEM_PYTHON: 'C:/tools/python.exe',
    })
    expect(paths.bundleDir).toBe('C:/repo/artifacts/bundle')
    expect(paths.nodePath).toBe('C:/tools/node.exe')
    expect(paths.pythonPath).toBe('C:/tools/python.exe')
  })

  it('preserves one bounded LLM extraction attempt while disabling embedder retries', () => {
    const bounded = applyModelRequestLimits({
      ...MODEL_ENV,
      MEMORY_LLM_MAX_RETRIES: '5',
      MEMORY_EMBEDDER_MAX_RETRIES: '3',
    })
    expect(bounded.MEMORY_LLM_MAX_RETRIES).toBe('1')
    expect(bounded.MEMORY_EMBEDDER_MAX_RETRIES).toBe('0')
  })

  it('writes JSON validation evidence and reports the target path on filesystem errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hymem-report-test-'))
    const report = { status: 'failed', checks: [{ id: 'synthetic', ok: false }] }
    const path = join(directory, 'report.json')
    try {
      writeJsonReport(path, report)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(report)

      try {
        writeJsonReport(join(directory, 'missing', 'report.json'), report)
        throw new Error('expected report write to fail')
      } catch (error) {
        expect(error).toMatchObject({ name: 'ReportWriteError', code: 'ENOENT', path: join(directory, 'missing', 'report.json') })
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('distinguishes unavailable usage from a measured zero and scores citations from answer text', () => {
    expect(normalizeUsage(undefined)).toEqual({
      available: false,
      total_tokens: null,
      prompt_tokens: null,
      completion_tokens: null,
      reasoning_tokens: null,
    })
    expect(normalizeUsage({ total_tokens: 17, prompt_tokens: 9, completion_tokens: 8 })).toMatchObject({
      available: true,
      total_tokens: 17,
      reasoning_tokens: null,
    })
    expect(scoreAnswer('CUDA 12.4 with pytest and amber-kite-7319', ['12.4', 'pytest', 'amber-kite-7319'], ['memory-1']))
      .toEqual({ factHit: true, citationHit: false, citedIds: [] })
    expect(scoreAnswer('CUDA 12.4, pytest, amber-kite-7319 (memory-1)', ['12.4', 'pytest', 'amber-kite-7319'], ['memory-1']))
      .toEqual({ factHit: true, citationHit: true, citedIds: ['memory-1'] })
  })

  it('treats adapter token counters as UNKNOWN provider usage', () => {
    expect(providerUsageFromMetrics({ tokens: 0, calls: { chatCompletions: 1, embeddings: 2 } })).toEqual({
      available: false,
      total_tokens: null,
      prompt_tokens: null,
      completion_tokens: null,
      reasoning_tokens: null,
      source: 'UNKNOWN',
    })
    expect(providerUsageFromMetrics({ providerUsage: { total_tokens: 19, prompt_tokens: 12, completion_tokens: 7 } })).toMatchObject({
      available: true,
      total_tokens: 19,
      source: 'provider-response',
    })
  })

  it('summarizes only approved effective model settings and hashes arbitrary extra_body', () => {
    const config = safeEffectiveModelConfig({
      ...MODEL_ENV,
      MEMORY_LLM_BASE_URL: 'https://private.example.test/v1',
      MEMORY_LLM_TEMPERATURE: '0.2',
      MEMORY_LLM_MAX_TOKENS: '777',
      MEMORY_AGENT_MAX_TOKENS: '888',
      MEMORY_LLM_MAX_RETRIES: '1',
      MEMORY_EMBEDDER_MAX_RETRIES: '0',
      MEMORY_MODE: 'hy',
      MEMORY_LLM_EXTRA_BODY: '{"enable_thinking":false}',
    })
    expect(config).toMatchObject({
      memoryMode: 'hy',
      llm: {
        model: 'chat-model',
        temperature: 0.2,
        maxTokens: 777,
        agentMaxTokens: 888,
        maxRetries: 1,
        extraBodyBooleans: { enable_thinking: false },
      },
      embedder: { model: 'embed-model', embeddingDims: 1024, maxRetries: 0 },
    })
    expect(JSON.stringify(config)).not.toContain('private.example.test')
    expect(JSON.stringify(config)).not.toContain(MODEL_ENV.MEMORY_LLM_API_KEY)

    const arbitrary = safeEffectiveModelConfig({
      ...MODEL_ENV,
      MEMORY_LLM_EXTRA_BODY: '{"enable_thinking":false,"prompt":"secret prompt"}',
    })
    expect(arbitrary.llm.extraBodyBooleans).toBeNull()
    expect(arbitrary.llm.extraBodyHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(arbitrary)).not.toContain('secret prompt')
  })

  it('stops a real local child process after it ignores graceful termination', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      windowsHide: true,
      stdio: 'ignore',
    })
    await once(child, 'spawn')

    await expect(stopOwnedChild(child, 100)).resolves.toBe(true)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('returns from timed out child commands only after owned process closure is confirmed', async () => {
    const result = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 })
    expect(result.timedOut).toBe(true)
    expect(result.processStopped).toBe(true)
  })

  it('handles an unavailable executable and cleans only its isolated worker files', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-worker-start-fail-'))
    try {
      await expect(startIsolatedWorker({
        pythonPath: join(dataDir, 'missing-python.exe'),
        bundleDir: dataDir,
        dataDir,
        env: {},
        modelPolicy: {},
        startupTimeoutMs: 1000,
      })).rejects.toThrow(/owned SDK worker/)
      expect(readdirSync(dataDir)).toEqual([])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('supports HTTP(S) provider requests and returns parsed usage without leaking response bodies', async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: '12.4; pytest' } }], usage: { total_tokens: 17 } }))
    })
    const result = await requestChatCompletion({
      env: { ...MODEL_ENV, MEMORY_LLM_BASE_URL: baseUrl },
      messages: [{ role: 'user', content: 'synthetic question' }],
      timeoutMs: 500,
    })
    expect(result.content).toBe('12.4; pytest')
    expect(result.usage.total_tokens).toBe(17)
  })

  it('bounds provider requests and hides non-200 and invalid JSON response bodies', async () => {
    const failureUrl = await listen((_request, response) => {
      response.writeHead(429, { 'content-type': 'text/plain' })
      response.end('response-secret must never enter logs')
    })
    await expect(requestChatCompletion({
      env: { ...MODEL_ENV, MEMORY_LLM_BASE_URL: failureUrl },
      messages: [{ role: 'user', content: 'synthetic question' }],
      timeoutMs: 500,
    })).rejects.toThrow(/HTTP 429/)
    await expect(requestChatCompletion({
      env: { ...MODEL_ENV, MEMORY_LLM_BASE_URL: failureUrl },
      messages: [{ role: 'user', content: 'synthetic question' }],
      timeoutMs: 500,
    })).rejects.not.toThrow(/response-secret/)

    const invalidUrl = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('not-json-secret')
    })
    await expect(requestChatCompletion({
      env: { ...MODEL_ENV, MEMORY_LLM_BASE_URL: invalidUrl },
      messages: [{ role: 'user', content: 'synthetic question' }],
      timeoutMs: 500,
    })).rejects.not.toThrow(/not-json-secret/)

    const slowUrl = await listen((_request, _response) => undefined)
    await expect(requestChatCompletion({
      env: { ...MODEL_ENV, MEMORY_LLM_BASE_URL: slowUrl },
      messages: [{ role: 'user', content: 'synthetic question' }],
      timeoutMs: 30,
    })).rejects.toThrow(/timeout/)
  })
})
