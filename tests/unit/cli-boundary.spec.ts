import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let fixture: string
let cli: string
const externalDataDirs: string[] = []

beforeAll(async () => {
  fixture = mkdtempSync(join(tmpdir(), 'hymem-cli-boundary-'))
  cli = join(fixture, 'cli.mjs')
  await build({
    entryPoints: [resolve('scripts/cli.ts')], outfile: cli, bundle: true,
    platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
  })
})

afterAll(() => {
  for (const dataDir of externalDataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
  rmSync(fixture, { recursive: true, force: true })
})

function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, DSH_HOME: join(fixture, 'fake-dsh'), ...extraEnv },
  })
}

function writeBundleFixture(root: string): void {
  const client = 'const port="__HYMEM_UI_PORT__"; const token="__HYMEM_UI_TOKEN__";\n'
  const patch = '- insert:\n    - id: hy-memory\n      name: dsh-hy-memory\n      config:\n        enabled: true\n        ui:\n          host: 127.0.0.1\n          port: 48731\n'
  const manifest = JSON.stringify({
    name: 'dsh-hy-memory',
    files: ['package.json', 'client.js', 'cordis.patch.yml', 'SHA256SUMS.json'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n'
  writeFileSync(join(root, 'package.json'), manifest)
  writeFileSync(join(root, 'client.js'), client)
  writeFileSync(join(root, 'cordis.patch.yml'), patch)
  const files = ['package.json', 'client.js', 'cordis.patch.yml']
  const checksums = Object.fromEntries(files.map(file => [
    file,
    createHash('sha256').update(readFileSync(join(root, file))).digest('hex'),
  ]))
  writeFileSync(join(root, 'SHA256SUMS.json'), `${JSON.stringify({ algorithm: 'sha256', files: checksums }, null, 2)}\n`)
}

describe('CLI process boundary', () => {
  it('returns a parseable error object for a failed JSON command', () => {
    const result = run(['restore', '--json', '--source', join(fixture, 'missing.db'), '--data-dir', join(fixture, 'new-data')])
    expect(result.status).toBe(1)
    const payload = JSON.parse(result.stdout)
    expect(payload).toMatchObject({ ok: false, error: { code: expect.any(String), message: expect.any(String) } })
    expect(payload.error).not.toHaveProperty('stack')
    expect(existsSync(join(fixture, 'new-data'))).toBe(false)
  })

  it('returns JSON for an unknown command with a nonzero exit code', () => {
    const result = run(['unsupported-command', '--json'])
    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false, command: 'unsupported-command', error: { code: 'E_VALIDATION' },
    })
  })

  it('previews installation without creating data, backups, tokens or changing the bundle', () => {
    const profile = join(fixture, 'fake-dsh', 'profiles', 'test-profile')
    mkdirSync(profile, { recursive: true })
    const manifest = JSON.stringify({ name: 'isolated-fixture', private: true })
    writeFileSync(join(profile, 'package.json'), manifest)
    const client = 'const port = "__HYMEM_UI_PORT__"; const token = "__HYMEM_UI_TOKEN__";\n'
    writeFileSync(join(fixture, 'client.js'), client)
    const dataDir = join(fixture, 'install-preview-data')

    const result = run(['install', '--profile', 'test-profile', '--dry-run', '--json', '--data-dir', dataDir])
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, dryRun: true })
    expect(existsSync(dataDir)).toBe(false)
    expect(readFileSync(join(fixture, 'client.js'), 'utf8')).toBe(client)
    expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(manifest)
  })

  it('rejects profile path traversal without writing outside the profiles root', () => {
    const outside = join(fixture, 'outside-profile')
    mkdirSync(outside, { recursive: true })
    const manifest = '{"name":"untouched"}\n'
    writeFileSync(join(outside, 'package.json'), manifest)
    const dataDir = join(fixture, 'invalid-profile-data')

    const result = run(['install', '--profile', '../outside-profile', '--dry-run', '--json', '--data-dir', dataDir])

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { message: expect.stringContaining('safe profile name') } })
    expect(readFileSync(join(outside, 'package.json'), 'utf8')).toBe(manifest)
    expect(existsSync(dataDir)).toBe(false)
  })

  it('rejects percent expansion markers in install profile names on every platform', () => {
    const dataDir = join(fixture, 'invalid-percent-profile-data')

    const result = run(['install', '--profile', 'safe-%HYMEM_PROFILE%', '--dry-run', '--json', '--data-dir', dataDir])

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false, error: { code: 'E_VALIDATION', message: expect.stringContaining('percent') },
    })
    expect(existsSync(dataDir)).toBe(false)
  })

  it('rejects percent expansion in uninstall profile names before invoking the launcher', () => {
    const marker = join(fixture, 'fake-launcher-invoked.txt')
    const launcher = join(fixture, 'fake-dsh.cmd')
    writeFileSync(launcher, `@echo off\r\necho invoked>"${marker}"\r\nexit /b 0\r\n`)

    const result = run(['uninstall', '--profile', 'safe%HYMEM_PROFILE%', '--json'], { DSH_LAUNCHER: launcher })

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false, error: { code: 'E_VALIDATION', message: expect.stringContaining('percent') },
    })
    expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('derives the desktop node executable from the DSH cmd wrapper layout', () => {
    const installRoot = join(fixture, 'fake-dsh-install')
    const launcher = join(installRoot, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
    const desktopExe = join(installRoot, 'DeepSeek Harness.exe')
    mkdirSync(join(installRoot, 'resources', 'runtime', 'cli', 'bin'), { recursive: true })
    writeFileSync(launcher, '@echo off\r\nchcp 65001 >nul 2>&1\r\necho %DSH_DESKTOP_NODE_EXECUTABLE%\r\necho %*\r\nexit /b 0\r\n')
    writeFileSync(desktopExe, '')

    const result = run(['uninstall', '--profile', '中文 profile', '--json'], {
      DSH_LAUNCHER: launcher,
      DSH_DESKTOP_NODE_EXECUTABLE: undefined,
    })

    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout).output as string
    expect(output).toContain(desktopExe)
    expect(output).toContain('中文 profile')
  })

  it.skipIf(process.platform !== 'win32')('returns E_VALIDATION before invoking a launcher path with percent expansion markers', () => {
    const marker = join(fixture, 'percent-launcher-invoked.txt')
    const launcher = join(fixture, 'fake-%HYMEM_TEST_LAUNCHER%.cmd')
    writeFileSync(launcher, `@echo off\r\necho invoked>"${marker}"\r\nexit /b 0\r\n`)

    const result = run(['uninstall', '--profile', 'safe-profile', '--json'], {
      DSH_LAUNCHER: launcher,
      HYMEM_TEST_LAUNCHER: 'unexpanded-target',
    })

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false, error: { code: 'E_VALIDATION', message: expect.stringContaining('percent') },
    })
    expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('rejects percent in the prospective bundle path before writing install data or invoking the launcher', () => {
    const profile = join(fixture, 'fake-dsh', 'profiles', 'safe-profile')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), '{"name":"safe-profile","private":true}\n')
    writeBundleFixture(fixture)
    const dataDir = join(tmpdir(), `hymem-cli-install-%HYMEM_TEST_DATA%-${process.pid}-${Date.now()}`)
    externalDataDirs.push(dataDir)
    const marker = join(fixture, 'install-launcher-invoked.txt')
    const launcher = join(fixture, 'fake-install-dsh.cmd')
    writeFileSync(launcher, `@echo off\r\necho invoked>"${marker}"\r\nexit /b 0\r\n`)

    const result = run(['install', '--profile', 'safe-profile', '--json', '--data-dir', dataDir], { DSH_LAUNCHER: launcher })

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false, error: { code: 'E_VALIDATION', message: expect.stringContaining('percent') },
    })
    expect(existsSync(dataDir)).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })
})
