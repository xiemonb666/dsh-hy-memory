import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { installTransaction } from '../../scripts/install-transaction.js'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hymem-install-transaction-'))
  fixtures.push(root)
  const dshHome = join(root, 'dsh')
  const profileDir = join(dshHome, 'profiles', '中文 profile')
  const sourceBundle = join(root, 'source-bundle')
  const dataDir = join(root, 'data')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(sourceBundle, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'fixture-profile', private: true }, null, 2))
  writeFileSync(join(sourceBundle, 'package.json'), JSON.stringify({
    name: 'dsh-hy-memory',
    files: ['client.js', 'index.js', 'cordis.patch.yml', 'SHA256SUMS.json'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(sourceBundle, 'client.js'), 'const port="__HYMEM_UI_PORT__"; const token="__HYMEM_UI_TOKEN__";\n')
  writeFileSync(join(sourceBundle, 'index.js'), 'export default {}\n')
  writeFileSync(join(sourceBundle, 'cordis.patch.yml'), '- insert:\n    - id: hy-memory\n      name: dsh-hy-memory\n      config:\n        enabled: true\n        ui:\n          host: 127.0.0.1\n          port: 48731\n')
  const checksums = Object.fromEntries(['package.json', 'client.js', 'index.js', 'cordis.patch.yml'].map(file => [
    file,
    createHash('sha256').update(readFileSync(join(sourceBundle, file))).digest('hex'),
  ]))
  writeFileSync(join(sourceBundle, 'SHA256SUMS.json'), `${JSON.stringify({ algorithm: 'sha256', files: checksums }, null, 2)}\n`)
  return { root, dshHome, profileDir, sourceBundle, dataDir }
}

describe('installTransaction', () => {
  it('installs a tokenized private bundle copy without changing the source bundle', async () => {
    const fixture = setup()
    const sourceClient = readFileSync(join(fixture.sourceBundle, 'client.js'), 'utf8')
    const sourcePatch = readFileSync(join(fixture.sourceBundle, 'cordis.patch.yml'), 'utf8')
    mkdirSync(join(fixture.sourceBundle, 'data'), { recursive: true })
    writeFileSync(join(fixture.sourceBundle, 'data', 'governance.db'), 'must not ship')
    writeFileSync(join(fixture.sourceBundle, '.env'), 'must not ship')
    const result = await installTransaction({
      dshHome: fixture.dshHome,
      profileName: '中文 profile',
      dataDir: fixture.dataDir,
      sourceBundle: fixture.sourceBundle,
      uiPort: 49321,
      uiToken: 'fixture-secret-token',
      runner: ({ profileDir }) => {
        const packagePath = join(profileDir, 'package.json')
        const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>
        manifest.dsh = { profile: { bundles: ['dsh-hy-memory'] } }
        writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`)
        return { code: 0, output: 'fake install completed' }
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(existsSync(result.privateBundleDir)).toBe(true)
    expect(existsSync(join(result.privateBundleDir, 'data'))).toBe(false)
    expect(existsSync(join(result.privateBundleDir, '.env'))).toBe(false)
    expect(readFileSync(join(result.privateBundleDir, 'client.js'), 'utf8')).toBe(
      'const port="49321"; const token="fixture-secret-token";\n',
    )
    const installedPatch = readFileSync(join(result.privateBundleDir, 'cordis.patch.yml'), 'utf8')
    expect(installedPatch).toContain(`dataDir: ${JSON.stringify(fixture.dataDir)}`)
    expect(installedPatch).toContain('port: 49321')
    expect(readFileSync(join(fixture.sourceBundle, 'client.js'), 'utf8')).toBe(sourceClient)
    expect(readFileSync(join(fixture.sourceBundle, 'cordis.patch.yml'), 'utf8')).toBe(sourcePatch)
    expect(JSON.stringify(result)).not.toContain('fixture-secret-token')
    expect(JSON.parse(readFileSync(join(fixture.profileDir, 'package.json'), 'utf8')).dsh.profile.bundles).toContain('dsh-hy-memory')
  })

  it('restores only the snapshotted profile metadata on runner failure', () => {
    const fixture = setup()
    const originals = new Map<string, string>([
      ['package.json', readFileSync(join(fixture.profileDir, 'package.json'), 'utf8')],
      ['cordis.patch.yml', '- original patch\n'],
      ['pnpm-lock.yaml', 'lockfileVersion: 9.0\n'],
      ['.plugin-manager/settings.json', '{"selected":["other-plugin"]}\n'],
    ])
    writeFileSync(join(fixture.profileDir, 'cordis.patch.yml'), originals.get('cordis.patch.yml')!)
    writeFileSync(join(fixture.profileDir, 'pnpm-lock.yaml'), originals.get('pnpm-lock.yaml')!)
    mkdirSync(join(fixture.profileDir, '.plugin-manager'))
    writeFileSync(join(fixture.profileDir, '.plugin-manager', 'settings.json'), originals.get('.plugin-manager/settings.json')!)
    mkdirSync(join(fixture.profileDir, 'node_modules'), { recursive: true })
    writeFileSync(join(fixture.profileDir, 'node_modules', 'keep.txt'), 'cache side effect is outside rollback scope')
    mkdirSync(fixture.dataDir, { recursive: true })
    writeFileSync(join(fixture.dataDir, 'governance.db'), 'retained memory data')

    let installedCopy = ''
    const result = installTransaction({
      dshHome: fixture.dshHome,
      profileName: '中文 profile',
      dataDir: fixture.dataDir,
      sourceBundle: fixture.sourceBundle,
      uiPort: 48731,
      uiToken: 'fixture-secret-token',
      runner: ({ profileDir, privateBundleDir }) => {
        installedCopy = privateBundleDir
        writeFileSync(join(profileDir, 'package.json'), '{ invalid json')
        writeFileSync(join(profileDir, 'cordis.patch.yml'), '- modified patch\n')
        writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'modified lock\n')
        writeFileSync(join(profileDir, '.plugin-manager', 'settings.json'), '{"selected":[]}\n')
        writeFileSync(join(profileDir, '.plugin-manager', 'new.json'), '{}\n')
        return { code: 17, output: 'runner output fixture-secret-token' }
      },
    })

    expect(result).toMatchObject({ ok: false, exitCode: 17, rollback: { attempted: true, ok: true, errors: [] } })
    expect(installedCopy).not.toBe('')
    expect(existsSync(installedCopy)).toBe(false)
    if (result.ok) return
    expect(result.output).not.toContain('fixture-secret-token')
    for (const [path, content] of originals) expect(readFileSync(join(fixture.profileDir, path), 'utf8')).toBe(content)
    expect(existsSync(join(fixture.profileDir, '.plugin-manager', 'new.json'))).toBe(false)
    expect(readFileSync(join(fixture.profileDir, 'node_modules', 'keep.txt'), 'utf8')).toContain('outside rollback scope')
    expect(readFileSync(join(fixture.dataDir, 'governance.db'), 'utf8')).toBe('retained memory data')
  })

  it('removes newly created managed targets when validation fails after a successful runner', () => {
    const fixture = setup()
    const originalPackage = readFileSync(join(fixture.profileDir, 'package.json'), 'utf8')
    let installedCopy = ''
    const result = installTransaction({
      dshHome: fixture.dshHome,
      profileName: '中文 profile',
      dataDir: fixture.dataDir,
      sourceBundle: fixture.sourceBundle,
      uiPort: 48731,
      uiToken: 'fixture-secret-token',
      runner: ({ profileDir, privateBundleDir }) => {
        installedCopy = privateBundleDir
        writeFileSync(join(profileDir, 'package.json'), '{ invalid JSON')
        writeFileSync(join(profileDir, 'cordis.patch.yml'), 'new patch\n')
        writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'new lock\n')
        mkdirSync(join(profileDir, '.plugin-manager', 'runs'), { recursive: true })
        writeFileSync(join(profileDir, '.plugin-manager', 'runs', 'current.json'), '{}\n')
        return { code: 0, output: 'fake runner said success' }
      },
    })

    expect(result).toMatchObject({ ok: false, rollback: { attempted: true, ok: true, errors: [] } })
    expect(installedCopy).not.toBe('')
    expect(existsSync(installedCopy)).toBe(false)
    expect(readFileSync(join(fixture.profileDir, 'package.json'), 'utf8')).toBe(originalPackage)
    expect(existsSync(join(fixture.profileDir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(fixture.profileDir, 'pnpm-lock.yaml'))).toBe(false)
    expect(existsSync(join(fixture.profileDir, '.plugin-manager'))).toBe(false)
  })

  it('rejects profile path traversal before touching the data directory or invoking the runner', () => {
    const fixture = setup()
    let invoked = false
    const result = installTransaction({
      dshHome: fixture.dshHome,
      profileName: '../outside',
      dataDir: join(fixture.root, 'must-not-exist'),
      sourceBundle: fixture.sourceBundle,
      uiPort: 48731,
      uiToken: 'fixture-secret-token',
      runner: () => {
        invoked = true
        return { code: 0, output: '' }
      },
    })

    expect(result).toMatchObject({ ok: false, rollback: { attempted: false } })
    if (!result.ok) expect(result.error).toContain('profile must be one safe profile name')
    expect(invoked).toBe(false)
    expect(existsSync(join(fixture.root, 'must-not-exist'))).toBe(false)
  })

  it('rejects percent expansion markers in profile names before touching the data directory', () => {
    const fixture = setup()
    const profileName = 'profile-%HYMEM_TEST_PROFILE%'
    const profileDir = join(fixture.dshHome, 'profiles', profileName)
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{"name":"percent-profile","private":true}\n')
    let invoked = false
    const result = installTransaction({
      dshHome: fixture.dshHome,
      profileName,
      dataDir: join(fixture.root, 'must-not-exist'),
      sourceBundle: fixture.sourceBundle,
      uiPort: 48731,
      uiToken: 'fixture-secret-token',
      runner: () => {
        invoked = true
        return { code: 0, output: '' }
      },
    })

    expect(result).toMatchObject({ ok: false, rollback: { attempted: false } })
    if (!result.ok) expect(result.error).toContain('percent')
    expect(invoked).toBe(false)
    expect(existsSync(join(fixture.root, 'must-not-exist'))).toBe(false)
  })

  it('retains and reports its exact private bundle if profile rollback cannot finish', () => {
    const fixture = setup()
    let installedCopy = ''
    const result = installTransaction({
      dshHome: fixture.dshHome, profileName: '中文 profile', dataDir: fixture.dataDir,
      sourceBundle: fixture.sourceBundle, uiPort: 48731, uiToken: 'fixture-secret-token',
      runner: ({ profileDir, privateBundleDir }) => {
        installedCopy = privateBundleDir
        const packagePath = join(profileDir, 'package.json')
        unlinkSync(packagePath)
        mkdirSync(packagePath)
        writeFileSync(join(packagePath, 'unowned.txt'), 'do not delete to force rollback')
        return { code: 17, output: '' }
      },
    })
    expect(result).toMatchObject({ ok: false, privateBundleDir: installedCopy, rollback: { attempted: true, ok: false } })
    expect(existsSync(installedCopy)).toBe(true)
    expect(readFileSync(join(fixture.profileDir, 'package.json', 'unowned.txt'), 'utf8')).toContain('do not delete')
    expect(JSON.stringify(result)).not.toContain('fixture-secret-token')
  })

  it('rejects a materialized source client before creating an install snapshot', () => {
    const fixture = setup()
    writeFileSync(join(fixture.sourceBundle, 'client.js'), 'const port="48731"; const token="already-set";\n')
    let invoked = false
    const result = installTransaction({
      dshHome: fixture.dshHome,
      profileName: '中文 profile',
      dataDir: join(fixture.root, 'materialized-source-data'),
      sourceBundle: fixture.sourceBundle,
      uiPort: 48731,
      uiToken: 'fixture-secret-token',
      runner: () => {
        invoked = true
        return { code: 0, output: '' }
      },
    })

    expect(result).toMatchObject({ ok: false, rollback: { attempted: false } })
    expect(invoked).toBe(false)
    expect(existsSync(join(fixture.root, 'materialized-source-data'))).toBe(false)
  })

  it.each(['access-token.txt', 'api_key.txt', 'private-key.pem', 'worker-token-test', 'db/private.json'])('rejects a checksummed source bundle containing python/%s', name => {
    const fixture = setup()
    const packagePath = join(fixture.sourceBundle, 'package.json')
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
    manifest.files.push('python/**')
    writeFileSync(packagePath, JSON.stringify(manifest))
    const privatePath = join(fixture.sourceBundle, 'python', name)
    mkdirSync(dirname(privatePath), { recursive: true })
    writeFileSync(privatePath, 'synthetic private material')
    const checksumPath = join(fixture.sourceBundle, 'SHA256SUMS.json')
    const checksum = JSON.parse(readFileSync(checksumPath, 'utf8'))
    checksum.files['package.json'] = createHash('sha256').update(readFileSync(packagePath)).digest('hex')
    checksum.files[`python/${name}`] = createHash('sha256').update(readFileSync(privatePath)).digest('hex')
    writeFileSync(checksumPath, JSON.stringify(checksum))
    let invoked = false
    const result = installTransaction({
      dshHome: fixture.dshHome, profileName: '中文 profile', dataDir: fixture.dataDir,
      sourceBundle: fixture.sourceBundle, uiPort: 48731, uiToken: 'fixture-secret-token',
      runner: () => { invoked = true; return { code: 0, output: '' } },
    })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toMatch(/private|environment|database/i)
    expect(invoked).toBe(false)
    expect(existsSync(fixture.dataDir)).toBe(false)
  })
})
