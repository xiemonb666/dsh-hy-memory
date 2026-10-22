import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'

// @ts-expect-error Runtime MJS helpers are imported directly by Vitest; no declarations are needed.
import { parseBuildOptions, publishBuildOutput } from '../../scripts/build-options.mjs'
// @ts-expect-error Runtime MJS helpers are imported directly by Vitest; no declarations are needed.
import { resolvePythonExecutable } from '../../scripts/run-python.mjs'

const legacyPackage = {
  name: 'dsh-hy-memory',
  version: '0.1.0',
  type: 'module',
  files: ['index.js', 'client.js', 'studio-api.js', 'cli.js', 'studio/**', 'python/**', 'locale/*.json', 'icon.svg', 'cordis.patch.yml'],
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: {
      platform: 'web',
      immediately: false,
      inject: ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar'],
    },
  },
  engines: { node: '>=24' },
  license: 'Apache-2.0',
}

function writeLegacyBundle(out: string, extraFiles: Record<string, string> = {}) {
  const files: Record<string, string> = {
    'index.js': 'host',
    'client.js': 'client',
    'studio-api.js': 'studio api',
    'cli.js': 'cli',
    'cordis.patch.yml': 'patch',
    'icon.svg': '<svg/>',
    'studio/index.html': '<html/>',
    'python/hymem_worker/__init__.py': '',
    'locale/en.json': '{}',
    'locale/zh.json': '{}',
    ...extraFiles,
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'package.json'), JSON.stringify(legacyPackage))
  for (const [path, contents] of Object.entries(files)) {
    const filePath = join(out, path)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, contents)
  }
  return files
}

function writeCurrentBundle(out: string) {
  const files = writeLegacyBundle(out)
  const currentPackage = {
    ...legacyPackage,
    files: [...legacyPackage.files, 'LICENSE', 'NOTICE', 'SHA256SUMS.json'],
    dsh: {
      ...legacyPackage.dsh,
      client: {
        ...legacyPackage.dsh.client,
        inject: [...legacyPackage.dsh.client.inject, '@deepseek-ai/dsh-client-ui-plugin-manager'],
      },
    },
  }
  files.LICENSE = 'Apache license fixture'
  files.NOTICE = 'Notice fixture'
  writeFileSync(join(out, 'LICENSE'), files.LICENSE)
  writeFileSync(join(out, 'NOTICE'), files.NOTICE)
  writeFileSync(join(out, 'package.json'), JSON.stringify(currentPackage))
  const checksums = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(([path, contents]) => [
    path,
    createHash('sha256').update(contents).digest('hex'),
  ]))
  checksums['package.json'] = createHash('sha256').update(readFileSync(join(out, 'package.json'))).digest('hex')
  writeFileSync(join(out, 'SHA256SUMS.json'), JSON.stringify({ algorithm: 'sha256', files: checksums }))
}

describe('build output safety', () => {
  let fixtureRoot: string
  let repoRoot: string

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'hymem-build-options-'))
    repoRoot = join(fixtureRoot, 'repo')
    mkdirSync(join(repoRoot, 'packages', 'host-plugin', 'src'), { recursive: true })
  })

  afterEach(() => {
    if (fixtureRoot.startsWith(`${resolve(tmpdir())}${sep}`) && basename(fixtureRoot).startsWith('hymem-build-options-')) {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('accepts an empty absolute output directory outside source trees', () => {
    const out = join(fixtureRoot, 'bundle')
    mkdirSync(out)

    expect(parseBuildOptions(['--out', out], { repoRoot }).out).toBe(out)
  })

  it('accepts a fresh artifact subdirectory but rejects the artifact root', () => {
    const artifactParent = join(repoRoot, 'artifacts', 'validation', '2026-10-21')
    mkdirSync(artifactParent, { recursive: true })
    const out = join(artifactParent, 'bundle')

    expect(parseBuildOptions(['--out', out], { repoRoot }).out).toBe(out)
    expect(() => parseBuildOptions(['--out', join(repoRoot, 'artifacts')], { repoRoot })).toThrow(/artifact root/i)
  })

  it('rejects filesystem roots, the repository root, and source directories', () => {
    const filesystemRoot = parse(repoRoot).root

    expect(() => parseBuildOptions(['--out', filesystemRoot], { repoRoot })).toThrow(/root/i)
    expect(() => parseBuildOptions(['--out', repoRoot], { repoRoot })).toThrow(/repository|source/i)
    expect(() => parseBuildOptions(['--out', join(repoRoot, 'packages', 'host-plugin')], { repoRoot })).toThrow(/source/i)
  })

  it('rejects nonempty existing output directories without changing their contents', () => {
    const out = join(fixtureRoot, 'already-used')
    mkdirSync(out)
    writeFileSync(join(out, 'keep.txt'), 'unowned')

    expect(() => parseBuildOptions(['--out', out], { repoRoot })).toThrow(/empty/i)
    expect(existsSync(join(out, 'keep.txt'))).toBe(true)
  })

  it('recognizes a legacy bundle from its package marker and generated file layout', () => {
    const out = join(fixtureRoot, 'legacy-bundle')
    writeLegacyBundle(out)

    expect(parseBuildOptions(['--out', out], { repoRoot }).out).toBe(out)
  })

  it('recognizes the current bundle marker and verifies every checksum', () => {
    const out = join(fixtureRoot, 'current-bundle')
    writeCurrentBundle(out)

    expect(parseBuildOptions(['--out', out], { repoRoot }).out).toBe(out)
    writeFileSync(join(out, 'client.js'), 'tampered client')
    expect(() => parseBuildOptions(['--out', out], { repoRoot })).toThrow(/checksum/i)
  })

  it('rejects an unknown nonempty output without changing user content', () => {
    const out = join(fixtureRoot, 'unknown-output')
    mkdirSync(out)
    writeFileSync(join(out, 'keep.txt'), 'user-owned')

    expect(() => parseBuildOptions(['--out', out], { repoRoot })).toThrow(/not a recognized HyMemory bundle/i)
    expect(existsSync(join(out, 'keep.txt'))).toBe(true)
  })

  it('rejects an unrecognized empty directory inside a generated bundle', () => {
    const out = join(fixtureRoot, 'bundle-with-unknown-directory')
    writeLegacyBundle(out)
    mkdirSync(join(out, 'user-owned-empty-dir'))

    expect(() => parseBuildOptions(['--out', out], { repoRoot })).toThrow(/unrecognized generated content/i)
    expect(existsSync(join(out, 'user-owned-empty-dir'))).toBe(true)
  })

  it('refuses to rebuild a bundle containing a private environment file', () => {
    const out = join(fixtureRoot, 'bundle-with-private-env')
    writeLegacyBundle(out)
    const privateEnvFile = join(out, 'studio', '.env.local')
    writeFileSync(privateEnvFile, 'synthetic-private-data')

    expect(() => parseBuildOptions(['--out', out], { repoRoot })).toThrow(/private environment file/i)
    expect(readFileSync(privateEnvFile, 'utf8')).toBe('synthetic-private-data')
  })

  it('publishes a recognized bundle twice while preserving its root and removing stale generated files', () => {
    const out = join(fixtureRoot, 'published-bundle')
    const firstStage = join(fixtureRoot, 'stage-one')
    const secondStage = join(fixtureRoot, 'stage-two')
    writeLegacyBundle(firstStage, { 'studio/assets/old.js': 'old generated asset' })
    writeLegacyBundle(secondStage, { 'client.js': 'updated client' })

    publishBuildOutput(firstStage, out, { repoRoot })
    const outputRoot = realpathSync(out)
    expect(parseBuildOptions(['--out', out], { repoRoot }).out).toBe(out)
    expect(existsSync(join(out, 'studio/assets/old.js'))).toBe(true)

    publishBuildOutput(secondStage, out, { repoRoot })

    expect(realpathSync(out)).toBe(outputRoot)
    expect(readFileSync(join(out, 'client.js'), 'utf8')).toBe('updated client')
    expect(existsSync(join(out, 'studio/assets/old.js'))).toBe(false)
    expect(parseBuildOptions(['--out', out], { repoRoot }).out).toBe(out)
  })

  it.each(['.envrc', 'memory-engine.env', 'local-memory.db', 'private-key.pem', 'worker-token-test', 'access-token.txt', 'api_key.txt', 'db/private.json'])('rejects private generated-tree content named %s', name => {
    const out = join(fixtureRoot, 'private-bundle')
    writeLegacyBundle(out, { [`studio/${name}`]: 'synthetic private material' })
    expect(() => parseBuildOptions(['--out', out], { repoRoot })).toThrow(/private/i)
    expect(readFileSync(join(out, 'studio', name), 'utf8')).toBe('synthetic private material')
  })

  it('restores the previous checked bundle when publishing fails partway through', () => {
    const out = join(fixtureRoot, 'rollback-bundle')
    const stage = join(fixtureRoot, 'new-stage')
    writeCurrentBundle(out)
    writeLegacyBundle(stage, { 'client.js': 'new client', 'studio/assets/new.js': 'new asset' })
    const original = readFileSync(join(out, 'SHA256SUMS.json'), 'utf8')
    expect(() => publishBuildOutput(stage, out, { repoRoot }, {
      beforePublish: (file: string) => { if (file === 'index.js') throw new Error('injected publish failure') },
    })).toThrow(/injected publish failure/)
    expect(readFileSync(join(out, 'client.js'), 'utf8')).toBe('client')
    expect(readFileSync(join(out, 'SHA256SUMS.json'), 'utf8')).toBe(original)
    expect(existsSync(join(out, 'studio/assets/new.js'))).toBe(false)
    expect(parseBuildOptions(['--out', out], { repoRoot }).out).toBe(out)
  })

  it('recovers an interrupted publisher on the next build without replacing the output root', () => {
    const out = join(fixtureRoot, 'interrupted-bundle')
    const stage = join(fixtureRoot, 'interrupted-stage')
    writeCurrentBundle(out)
    writeLegacyBundle(stage, { 'client.js': 'interrupted new client' })
    const beforeRoot = realpathSync(out)
    const helperUrl = new URL('../../scripts/build-options.mjs', import.meta.url).href
    const source = `import { publishBuildOutput } from ${JSON.stringify(helperUrl)};
      publishBuildOutput(${JSON.stringify(stage)}, ${JSON.stringify(out)}, { repoRoot: ${JSON.stringify(repoRoot)} }, {
        beforePublish(file) { if (file === 'index.js') process.exit(77) }
      });`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    expect(child.status, child.stderr).toBe(77)
    expect(readFileSync(join(out, 'client.js'), 'utf8')).toBe('interrupted new client')
    expect(parseBuildOptions(['--out', out], { repoRoot }).out).toBe(out)
    expect(realpathSync(out)).toBe(beforeRoot)
    expect(readFileSync(join(out, 'client.js'), 'utf8')).toBe('client')
    publishBuildOutput(stage, out, { repoRoot })
    expect(readFileSync(join(out, 'client.js'), 'utf8')).toBe('interrupted new client')
  })

  it.each([undefined, 'false', false])('preserves all recovery evidence for malformed or contradictory hadFiles=%s', hadFiles => {
    const out = join(fixtureRoot, 'malformed-journal-bundle')
    const stage = join(fixtureRoot, 'malformed-journal-stage')
    writeCurrentBundle(out)
    writeLegacyBundle(stage, { 'client.js': 'partial publish' })
    const helperUrl = new URL('../../scripts/build-options.mjs', import.meta.url).href
    const source = `import { publishBuildOutput } from ${JSON.stringify(helperUrl)};
      publishBuildOutput(${JSON.stringify(stage)}, ${JSON.stringify(out)}, { repoRoot: ${JSON.stringify(repoRoot)} }, {
        beforePublish(file) { if (file === 'index.js') process.exit(77) }
      });`
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).status).toBe(77)
    const journalPath = join(dirname(out), `.${basename(out)}.hymem-publish.json`)
    const state = JSON.parse(readFileSync(journalPath, 'utf8'))
    state.hadFiles = hadFiles
    writeFileSync(journalPath, JSON.stringify(state))
    expect(() => parseBuildOptions(['--out', out], { repoRoot })).toThrow(/journal/i)
    expect(readFileSync(join(out, 'client.js'), 'utf8')).toBe('partial publish')
    expect(readFileSync(join(state.backup, 'client.js'), 'utf8')).toBe('client')
    expect(existsSync(journalPath)).toBe(true)
  })

  it('rejects output inside a profile root or above a protected profile root', () => {
    const protectedHome = join(fixtureRoot, 'user-profile')
    const privateOutput = join(protectedHome, 'dsh-plugin')
    expect(() => parseBuildOptions(['--out', privateOutput], {
      repoRoot,
      home: protectedHome,
      temp: join(fixtureRoot, 'safe-temp'),
    })).toThrow(/protected user or system directory/i)

    const sharedParent = join(fixtureRoot, 'parent')
    expect(() => parseBuildOptions(['--out', sharedParent], {
      repoRoot,
      home: join(sharedParent, 'user-profile'),
      temp: join(fixtureRoot, 'safe-temp'),
    })).toThrow(/protected user or system directory/i)
  })

  it('rejects relative, missing, and unknown options', () => {
    expect(() => parseBuildOptions(['--out', 'relative'], { repoRoot })).toThrow(/absolute/i)
    expect(() => parseBuildOptions(['--out'], { repoRoot })).toThrow(/requires/i)
    expect(() => parseBuildOptions(['--force'], { repoRoot })).toThrow(/unknown/i)
  })
})

describe('cross-platform Python selection', () => {
  let fixtureRoot: string

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'hymem-python-runtime-'))
  })

  afterEach(() => {
    if (fixtureRoot.startsWith(`${resolve(tmpdir())}${sep}`) && basename(fixtureRoot).startsWith('hymem-python-runtime-')) {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('prefers an explicit HYMEM_PYTHON command', () => {
    expect(resolvePythonExecutable({
      root: fixtureRoot,
      environment: { HYMEM_PYTHON: 'python-from-ci' },
      spawn: () => { throw new Error('explicit interpreter should not probe fallback commands') },
    })).toBe('python-from-ci')
  })

  it('uses the interpreter from UV_PROJECT_ENVIRONMENT before local or system Python', () => {
    const environmentRoot = join(fixtureRoot, 'locked-venv')
    const executable = join(environmentRoot, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
    mkdirSync(join(environmentRoot, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true })
    writeFileSync(executable, '')

    expect(resolvePythonExecutable({
      root: fixtureRoot,
      environment: { UV_PROJECT_ENVIRONMENT: environmentRoot },
      spawn: () => { throw new Error('configured uv interpreter should not probe system Python') },
    })).toBe(executable)
  })

  it('uses a repository-local virtual environment before system Python', () => {
    const localVenv = join(fixtureRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin')
    const executable = join(localVenv, process.platform === 'win32' ? 'python.exe' : 'python')
    mkdirSync(localVenv, { recursive: true })
    writeFileSync(executable, '')

    expect(resolvePythonExecutable({
      root: fixtureRoot,
      environment: {},
      spawn: () => { throw new Error('local virtualenv should not probe system Python') },
    })).toBe(executable)
  })

  it('tries the platform-preferred system command before its alternate', () => {
    const calls: string[] = []
    const first = process.platform === 'win32' ? 'python' : 'python3'
    const second = process.platform === 'win32' ? 'python3' : 'python'
    const selected = resolvePythonExecutable({
      root: fixtureRoot,
      environment: {},
      exists: () => false,
      spawn: (command: string) => {
        calls.push(command)
        return { status: command === second ? 0 : 1, error: command === first ? Object.assign(new Error('missing'), { code: 'ENOENT' }) : undefined }
      },
    })

    expect(calls).toEqual([first, second])
    expect(selected).toBe(second)
  })

  it('does not silently fall back when an explicit uv environment is invalid', () => {
    const calls: string[] = []

    expect(() => resolvePythonExecutable({
      root: fixtureRoot,
      environment: { UV_PROJECT_ENVIRONMENT: join(fixtureRoot, 'missing-venv') },
      exists: () => false,
      spawn: (command: string) => { calls.push(command); return { status: 0 } },
    })).toThrow(/UV_PROJECT_ENVIRONMENT/i)
    expect(calls).toEqual([])
  })
})
