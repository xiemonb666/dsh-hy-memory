import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const childProcessMocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: childProcessMocks.spawn }
})

import type { HostConfig } from '../../packages/host-plugin/src/config.js'
import { startWorker } from '../../packages/host-plugin/src/worker.js'

type FakeChild = EventEmitter & {
  pid: number
  killed: boolean
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stdout: EventEmitter & { destroyed: boolean; destroy(): FakeChild['stdout'] }
  stderr: EventEmitter & { destroyed: boolean; destroy(): FakeChild['stderr'] }
  stdin: EventEmitter & { destroy(): FakeChild['stdin'] }
  kill: ReturnType<typeof vi.fn>
}

const dataDirs: string[] = []
const children: FakeChild[] = []
let spawnCount = 0

function makeChild(pid: number, autoClose: boolean): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.killed = false
  child.exitCode = null
  child.signalCode = null
  child.stdout = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy() { this.destroyed = true; return this },
  }) as FakeChild['stdout']
  child.stderr = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy() { this.destroyed = true; return this },
  }) as FakeChild['stderr']
  child.stdin = Object.assign(new EventEmitter(), { destroy() { return this } }) as FakeChild['stdin']
  child.kill = vi.fn(() => {
    child.killed = true
    if (autoClose) {
      queueMicrotask(() => {
        child.exitCode = 0
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
      })
    }
    return true
  })
  children.push(child)
  return child
}

function workerConfig(dataDir: string, overrides: Record<string, unknown> = {}): HostConfig {
  return {
    dataDir,
    worker: {
      url: null,
      token: null,
      python: 'python',
      port: 0,
      autoSpawn: true,
      engine: 'mock',
      startupTimeoutMs: 500,
      requestTimeoutMs: 1000,
      ...overrides,
    },
  } as HostConfig
}

function installFakeSpawn({ autoClose = true, writePort = true }: { autoClose?: boolean; writePort?: boolean } = {}): void {
  childProcessMocks.spawn.mockImplementation((_command: string, args: string[]) => {
    spawnCount += 1
    const tokenFile = args[args.indexOf('--token-file') + 1]
    const portFile = args[args.indexOf('--port-file') + 1]
    if (!tokenFile || !portFile) throw new Error('worker spawn omitted ownership file paths')
    if (writePort) writeFileSync(portFile, String(45000 + spawnCount))
    expect(existsSync(tokenFile)).toBe(true)
    return makeChild(100 + spawnCount, autoClose) as unknown as ChildProcess
  })
}

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
  children.splice(0)
  spawnCount = 0
  vi.clearAllMocks()
})

describe('owned worker file isolation', () => {
  it('gives concurrent workers distinct token/port files and only removes its own files on stop', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-worker-ownership-'))
    dataDirs.push(dataDir)
    installFakeSpawn()

    const first = await startWorker(workerConfig(dataDir), 'C:/bundle', { info() {}, warn() {} })
    const second = await startWorker(workerConfig(dataDir), 'C:/bundle', { info() {}, warn() {} })

    expect(first.tokenFile).toBeTruthy()
    expect(first.portFile).toBeTruthy()
    expect(second.tokenFile).toBeTruthy()
    expect(second.portFile).toBeTruthy()
    expect(first.tokenFile).not.toBe(second.tokenFile)
    expect(first.portFile).not.toBe(second.portFile)
    expect(readFileSync(first.tokenFile!, 'utf8').trim()).toBe(first.token)
    expect(readFileSync(second.tokenFile!, 'utf8').trim()).toBe(second.token)

    await first.stop()

    expect(existsSync(first.tokenFile!)).toBe(false)
    expect(existsSync(first.portFile!)).toBe(false)
    expect(existsSync(second.tokenFile!)).toBe(true)
    expect(existsSync(second.portFile!)).toBe(true)

    await second.stop()
    expect(existsSync(second.tokenFile!)).toBe(false)
    expect(existsSync(second.portFile!)).toBe(false)
  })

  it('keeps owned files until the child close event confirms it has stopped', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-worker-close-'))
    dataDirs.push(dataDir)
    installFakeSpawn({ autoClose: false })
    const worker = await startWorker(workerConfig(dataDir), 'C:/bundle', { info() {}, warn() {} })

    const stopped = worker.stop()
    expect(existsSync(worker.tokenFile!)).toBe(true)
    expect(existsSync(worker.portFile!)).toBe(true)

    children[0]!.exitCode = 0
    children[0]!.emit('close', 0, null)
    await stopped

    expect(existsSync(worker.tokenFile!)).toBe(false)
    expect(existsSync(worker.portFile!)).toBe(false)
  })

  it('cleans only its own files after a bounded startup failure and child shutdown', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-worker-start-failure-'))
    dataDirs.push(dataDir)
    installFakeSpawn({ writePort: false })

    await expect(startWorker(workerConfig(dataDir, { startupTimeoutMs: 50 }), 'C:/bundle', { info() {}, warn() {} }))
      .rejects.toThrow('worker did not report a port before the startup timeout')

    expect(children[0]?.killed).toBe(true)
    expect(existsSync(join(dataDir, 'worker-token'))).toBe(false)
    expect(existsSync(join(dataDir, 'worker-port'))).toBe(false)
    expect((await import('node:fs')).readdirSync(dataDir)).toEqual([])
  })

  it('does not expose owned token-file fields for an attached worker', async () => {
    const worker = await startWorker(workerConfig('C:/unused', {
      url: 'http://127.0.0.1:45678',
      token: 'synthetic-token',
    }), 'C:/bundle', { info() {}, warn() {} })

    expect(worker.owned).toBe(false)
    expect(worker.tokenFile).toBeUndefined()
    expect(worker.portFile).toBeUndefined()
    expect(childProcessMocks.spawn).not.toHaveBeenCalled()
  })
})
