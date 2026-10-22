import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ErrorCode, HyMemoryError } from '../packages/contracts/src/index.js'
import { isPrivateBundlePath } from './bundle-policy.mjs'

const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'] as const
const PROFILE_METADATA = '.plugin-manager'
const SOURCE_PORT = '__HYMEM_UI_PORT__'
const SOURCE_TOKEN = '__HYMEM_UI_TOKEN__'

export interface InstallTransactionOptions {
  dshHome: string
  profileName: string
  dataDir: string
  sourceBundle: string
  uiPort: number
  uiToken: string | (() => string)
  runner: (input: { profileName: string; profileDir: string; privateBundleDir: string }) => { code: number; output: string }
}

export type InstallTransactionResult =
  | { ok: true; profile: string; privateBundleDir: string; backupDir: string; output: string }
  | {
      ok: false
      profile: string
      exitCode: number
      error: string
      output: string
      backupDir?: string
      privateBundleDir?: string
      rollback: { attempted: boolean; ok: boolean; errors: string[] }
    }

interface ProfilePaths {
  profilesRoot: string
  profileDir: string
  packageJson: string
  patch: string
  lock: string
  metadata: string
}

interface SnapshotTarget {
  path: string
  existed: boolean
}

interface SnapshotFile {
  path: string
  sha256: string
  mode: number
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function prospectiveRealPath(path: string): string {
  const absolute = resolve(path)
  let cursor = absolute
  const tail: string[] = []
  while (!pathEntryExists(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) throw new Error(`cannot resolve destination path: ${path}`)
    tail.unshift(basename(cursor))
    cursor = parent
  }
  return resolve(realpathSync(cursor), ...tail)
}

function assertSafeProfileName(profileName: string): void {
  const hasControlCharacter = [...profileName].some(character => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  if (
    !profileName || profileName === '.' || profileName === '..' || profileName.includes('..') ||
    /[%\\/:<>"|?*]/.test(profileName) || hasControlCharacter || /[. ]$/.test(profileName) || isAbsolute(profileName)
  ) {
    throw new HyMemoryError(
      ErrorCode.VALIDATION,
      'profile must be one safe profile name without percent signs, path separators, colon, or traversal segments',
    )
  }
}

export function resolveProfilePaths(dshHome: string, profileName: string): ProfilePaths {
  assertSafeProfileName(profileName)
  const profilesRoot = resolve(dshHome, 'profiles')
  const profileDir = resolve(profilesRoot, profileName)
  if (!isWithin(profilesRoot, profileDir) || relative(profilesRoot, profileDir).includes(sep)) {
    throw new Error('profile path must resolve to one child of the DSH profiles directory')
  }
  return {
    profilesRoot,
    profileDir,
    packageJson: join(profileDir, 'package.json'),
    patch: join(profileDir, 'cordis.patch.yml'),
    lock: join(profileDir, 'pnpm-lock.yaml'),
    metadata: join(profileDir, PROFILE_METADATA),
  }
}

function assertPlainDirectory(path: string, description: string): void {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new Error(`${description} does not exist: ${path}`)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${description} must be a real directory, not a symlink or junction: ${path}`)
}

function assertPlainFile(path: string, description: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${description} must be a regular file: ${path}`)
}

function assertNoPrivateBundlePath(path: string): void {
  if (isPrivateBundlePath(path)) {
    throw new Error(`refusing to include private data, environment, or database file in bundle: ${path}`)
  }
}

function safeRelativePath(value: string, rejectPrivate = true): string {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some(part => part === '..' || part === '.')) {
    throw new Error(`unsafe bundle path: ${value}`)
  }
  if (rejectPrivate) assertNoPrivateBundlePath(normalized)
  return normalized
}

function collectTreeFiles(root: string, relativeRoot: string, output: string[]): void {
  const directory = join(root, ...relativeRoot.split('/').filter(Boolean))
  const stat = lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`bundle path is not a real directory: ${relativeRoot}`)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const rel = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name
    safeRelativePath(rel)
    const full = join(root, ...rel.split('/'))
    const childStat = lstatSync(full)
    if (childStat.isSymbolicLink()) throw new Error(`bundle contains a symlink or junction: ${rel}`)
    if (childStat.isDirectory()) collectTreeFiles(root, rel, output)
    else if (childStat.isFile()) output.push(rel)
    else throw new Error(`bundle contains an unsupported filesystem entry: ${rel}`)
  }
}

function expandBundleFiles(root: string, files: unknown): string[] {
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) throw new Error('bundle package.json must declare a files array')
  // npm always includes package.json even when it is absent from `files`.
  // Keep it in the copied inventory and in the exact checksum comparison.
  const expanded = new Set<string>(['package.json'])
  for (const raw of files as string[]) {
    const spec = safeRelativePath(raw)
    const recursive = spec.endsWith('/**')
    const oneLevelGlob = /^(.*)\/\*\.([A-Za-z0-9_-]+)$/.exec(spec)
    if (recursive) {
      const prefix = spec.slice(0, -3).replace(/\/$/, '')
      const matches: string[] = []
      collectTreeFiles(root, prefix, matches)
      for (const path of matches) expanded.add(path)
      continue
    }
    if (oneLevelGlob) {
      const prefix = oneLevelGlob[1]!
      const extension = oneLevelGlob[2]!
      const directory = join(root, prefix)
      const stat = lstatSync(directory)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`bundle file pattern is not a real directory: ${prefix}`)
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.name.endsWith(`.${extension}`)) continue
        const path = safeRelativePath(`${prefix}/${entry.name}`)
        const full = join(root, ...path.split('/'))
        const childStat = lstatSync(full)
        if (childStat.isSymbolicLink() || !childStat.isFile()) throw new Error(`bundle file pattern matched a non-file: ${path}`)
        expanded.add(path)
      }
      continue
    }
    if (spec.includes('*')) throw new Error(`unsupported bundle files pattern: ${spec}`)
    const full = join(root, ...spec.split('/'))
    assertPlainFile(full, `bundle file ${spec}`)
    expanded.add(spec)
  }
  const result = [...expanded].sort()
  for (const required of ['package.json', 'client.js', 'cordis.patch.yml']) {
    if (!expanded.has(required)) throw new Error(`bundle package.json files list must include ${required}`)
  }
  return result
}

function validateSourceBundle(sourceBundle: string): { files: string[]; packageName: string; clientSource: string } {
  assertPlainDirectory(sourceBundle, 'source bundle')
  const sourceRoot = realpathSync(sourceBundle)
  assertNoSymlinksInTree(sourceRoot)
  const packagePath = join(sourceRoot, 'package.json')
  assertPlainFile(packagePath, 'source bundle package.json')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>
  } catch {
    throw new Error('source bundle package.json is invalid JSON')
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('source bundle package.json has no valid package name')
  if (manifest.name !== 'dsh-hy-memory') throw new Error('source bundle package.json is not the dsh-hy-memory plugin')
  const dsh = manifest.dsh
  const bundle = typeof dsh === 'object' && dsh !== null ? (dsh as Record<string, unknown>).bundle : undefined
  if (typeof bundle !== 'object' || bundle === null || (bundle as Record<string, unknown>).patch !== './cordis.patch.yml') {
    throw new Error('source bundle package.json does not declare the expected DSH bundle patch')
  }
  const files = expandBundleFiles(sourceRoot, manifest.files)
  if (!files.includes('SHA256SUMS.json')) throw new Error('source bundle files list must include SHA256SUMS.json')
  const clientPath = join(sourceRoot, 'client.js')
  assertPlainFile(clientPath, 'source bundle client.js')
  const clientSource = readFileSync(clientPath, 'utf8')
  if (clientSource.split(SOURCE_PORT).length !== 2 || clientSource.split(SOURCE_TOKEN).length !== 2) {
    throw new Error('source bundle client.js must contain exactly one port and token placeholder; refusing unknown or materialized source')
  }
  const checksumPath = join(sourceRoot, 'SHA256SUMS.json')
  if (pathEntryExists(checksumPath)) {
    assertPlainFile(checksumPath, 'source bundle SHA256SUMS.json')
    let checksums: { algorithm?: unknown; files?: Record<string, unknown> }
    try {
      checksums = JSON.parse(readFileSync(checksumPath, 'utf8')) as typeof checksums
    } catch {
      throw new Error('source bundle SHA256SUMS.json is invalid JSON')
    }
    if (checksums.algorithm !== 'sha256' || typeof checksums.files !== 'object' || checksums.files === null || Array.isArray(checksums.files)) {
      throw new Error('source bundle SHA256SUMS.json has an unsupported format')
    }
    const expectedPaths = files.filter(path => path !== 'SHA256SUMS.json').sort()
    const checksumPaths = Object.keys(checksums.files).sort()
    if (JSON.stringify(checksumPaths) !== JSON.stringify(expectedPaths)) throw new Error('source bundle checksum manifest does not cover exactly the packaged files')
    for (const [raw, expected] of Object.entries(checksums.files)) {
      const rel = safeRelativePath(raw)
      if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error(`invalid checksum entry for ${rel}`)
      const path = join(sourceRoot, ...rel.split('/'))
      assertPlainFile(path, `checksummed bundle file ${rel}`)
      if (sha256(readFileSync(path)) !== expected.toLowerCase()) throw new Error(`source bundle checksum mismatch: ${rel}`)
    }
  }
  return { files, packageName: manifest.name, clientSource }
}

function ensureChildDirectory(parent: string, childName: string): string {
  const path = join(parent, childName)
  if (!isWithin(parent, path) || relative(parent, path).includes(sep)) throw new Error(`unsafe managed directory path: ${path}`)
  if (pathEntryExists(path)) assertPlainDirectory(path, 'managed directory')
  else mkdirSync(path)
  return path
}

function assertNoSymlinksInTree(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`refusing symlink or junction: ${path}`)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) assertNoSymlinksInTree(join(path, entry))
  } else if (!stat.isFile()) {
    throw new Error(`unsupported filesystem entry: ${path}`)
  }
}

function copyTree(source: string, destination: string, files: SnapshotFile[]): void {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    const stat = lstatSync(from)
    if (stat.isSymbolicLink()) throw new Error(`refusing to snapshot symlink or junction: ${from}`)
    if (stat.isDirectory()) copyTree(from, to, files)
    else if (stat.isFile()) {
      copyFileSync(from, to)
      chmodSync(to, stat.mode & 0o777)
      files.push({ path: to, sha256: sha256(readFileSync(to)), mode: stat.mode & 0o777 })
    } else throw new Error(`unsupported profile metadata entry: ${from}`)
  }
}

function createSnapshot(paths: ProfilePaths, dataDir: string, profileName: string): { backupDir: string; snapshotRoot: string } {
  const backupRoot = ensureChildDirectory(dataDir, 'profile-backups')
  const backupDir = mkdtempSync(join(backupRoot, `${profileName}-`))
  const snapshotRoot = join(backupDir, 'snapshot')
  const profileSnapshot = join(snapshotRoot, 'profile')
  mkdirSync(profileSnapshot, { recursive: true })
  const targets: SnapshotTarget[] = []
  const files: SnapshotFile[] = []
  for (const name of PROFILE_FILES) {
    const source = join(paths.profileDir, name)
    const existed = pathEntryExists(source)
    targets.push({ path: name, existed })
    if (!existed) continue
    assertPlainFile(source, `profile ${name}`)
    const destination = join(profileSnapshot, name)
    copyFileSync(source, destination)
    const stat = lstatSync(source)
    chmodSync(destination, stat.mode & 0o777)
    files.push({ path: destination, sha256: sha256(readFileSync(destination)), mode: stat.mode & 0o777 })
  }
  const metadata = paths.metadata
  const metadataExists = pathEntryExists(metadata)
  targets.push({ path: PROFILE_METADATA, existed: metadataExists })
  if (metadataExists) {
    assertPlainDirectory(metadata, 'profile .plugin-manager metadata')
    assertNoSymlinksInTree(metadata)
    copyTree(metadata, join(profileSnapshot, PROFILE_METADATA), files)
  }
  writeFileSync(join(backupDir, 'manifest.json'), `${JSON.stringify({
    algorithm: 'sha256',
    profile: profileName,
    createdAt: new Date().toISOString(),
    targets,
    files: files.map(file => ({ ...file, path: relative(snapshotRoot, file.path).split(sep).join('/') })),
  }, null, 2)}\n`)
  return { backupDir, snapshotRoot }
}

function validateSnapshot(backupDir: string, snapshotRoot: string): { targets: SnapshotTarget[]; files: SnapshotFile[] } {
  const manifestPath = join(backupDir, 'manifest.json')
  assertPlainFile(manifestPath, 'install snapshot manifest')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { algorithm?: unknown; targets?: unknown; files?: unknown }
  if (manifest.algorithm !== 'sha256' || !Array.isArray(manifest.targets) || !Array.isArray(manifest.files)) throw new Error('install snapshot manifest is invalid')
  const targets = manifest.targets as SnapshotTarget[]
  const files = manifest.files as SnapshotFile[]
  for (const file of files) {
    if (typeof file.path !== 'string' || typeof file.sha256 !== 'string' || !Number.isInteger(file.mode)) throw new Error('install snapshot manifest has an invalid file entry')
    const rel = safeRelativePath(file.path, false)
    const source = join(snapshotRoot, ...rel.split('/'))
    assertPlainFile(source, `snapshot file ${rel}`)
    if (sha256(readFileSync(source)) !== file.sha256) throw new Error(`install snapshot checksum mismatch: ${rel}`)
  }
  for (const target of targets) {
    if (typeof target.path !== 'string' || typeof target.existed !== 'boolean' || ![...PROFILE_FILES, PROFILE_METADATA].includes(target.path as never)) {
      throw new Error('install snapshot manifest has an invalid target entry')
    }
  }
  return { targets, files }
}

function removeTreeWithoutFollowingLinks(path: string): void {
  if (!pathEntryExists(path)) return
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    rmSync(path, { force: true })
  } else if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) removeTreeWithoutFollowingLinks(join(path, entry))
    rmdirSync(path)
  } else if (stat.isFile()) rmSync(path, { force: true })
  else throw new Error(`cannot safely remove unsupported profile entry: ${path}`)
}

function removeAbsentTarget(path: string, isTree: boolean): void {
  if (!pathEntryExists(path)) return
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    rmSync(path, { force: true })
    return
  }
  if (isTree) {
    removeTreeWithoutFollowingLinks(path)
    return
  }
  if (stat.isFile()) rmSync(path, { force: true })
  else if (stat.isDirectory()) rmdirSync(path)
  else throw new Error(`cannot safely remove unsupported profile entry: ${path}`)
}

function restoreFile(source: string, destination: string, mode: number): void {
  const parent = dirname(destination)
  mkdirSync(parent, { recursive: true })
  if (pathEntryExists(destination)) {
    const stat = lstatSync(destination)
    if (stat.isDirectory() && !stat.isSymbolicLink()) throw new Error(`cannot replace directory at managed file path: ${destination}`)
    rmSync(destination, { force: true })
  }
  const temporary = join(parent, `.${basename(destination)}.restore-${randomUUID()}`)
  copyFileSync(source, temporary)
  chmodSync(temporary, mode)
  renameSync(temporary, destination)
}

function rollbackProfile(paths: ProfilePaths, backupDir: string, snapshotRoot: string): { attempted: boolean; ok: boolean; errors: string[] } {
  const errors: string[] = []
  try {
    assertProfileStillContained(paths)
    const snapshot = validateSnapshot(backupDir, snapshotRoot)
    for (const target of snapshot.targets) {
      const destination = join(paths.profileDir, target.path)
      try {
        if (!target.existed) {
          removeAbsentTarget(destination, target.path === PROFILE_METADATA)
          continue
        }
        if (target.path === PROFILE_METADATA) {
          removeTreeWithoutFollowingLinks(destination)
          const source = join(snapshotRoot, 'profile', PROFILE_METADATA)
          if (!existsSync(source)) throw new Error('snapshot metadata tree is missing')
          copyTree(source, destination, [])
          continue
        }
        const file = snapshot.files.find(item => item.path === `profile/${target.path}`)
        if (!file) throw new Error(`snapshot file is missing for ${target.path}`)
        restoreFile(join(snapshotRoot, 'profile', target.path), destination, file.mode)
      } catch (error) {
        errors.push(`${target.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  return { attempted: true, ok: errors.length === 0, errors }
}

function copyBundleToPrivate(sourceBundle: string, dataDir: string, profileName: string, files: string[], clientSource: string, uiPort: number, uiToken: string): string {
  const bundlesRoot = ensureChildDirectory(dataDir, 'installed-bundles')
  const profileBundles = ensureChildDirectory(bundlesRoot, profileName)
  const stage = mkdtempSync(join(profileBundles, '.stage-'))
  try {
    const copied: string[] = []
    for (const rel of files) {
      const source = join(sourceBundle, ...rel.split('/'))
      assertPlainFile(source, `bundle file ${rel}`)
      const destination = join(stage, ...rel.split('/'))
      mkdirSync(resolve(destination, '..'), { recursive: true })
      copyFileSync(source, destination)
      const mode = lstatSync(source).mode & 0o777
      chmodSync(destination, mode)
      copied.push(rel)
    }
    const privateClient = clientSource.replace(SOURCE_PORT, String(uiPort)).replace(SOURCE_TOKEN, uiToken)
    writeFileSync(join(stage, 'client.js'), privateClient)
    chmodSync(join(stage, 'client.js'), lstatSync(join(sourceBundle, 'client.js')).mode & 0o777)
    // Materialize both sides of the bridge. Otherwise --data-dir/--ui-port
    // only move the client while the actual Host keeps its default settings.
    const patchPath = join(stage, 'cordis.patch.yml')
    const patch = readFileSync(patchPath, 'utf8')
    const configHeader = /^ {6}config:\s*$/gm
    const portLine = /^ {10}port: 48731\s*$/gm
    if ([...patch.matchAll(configHeader)].length !== 1 || [...patch.matchAll(portLine)].length !== 1 || /^\s*dataDir:/m.test(patch)) {
      throw new Error('source bundle patch is not the recognized unconfigured Host template')
    }
    writeFileSync(patchPath, patch
      .replace(configHeader, `      config:\n        dataDir: ${JSON.stringify(dataDir)}`)
      .replace(portLine, `          port: ${uiPort}`))
    if (copied.includes('SHA256SUMS.json')) {
      const checksums = Object.fromEntries(copied.filter(path => path !== 'SHA256SUMS.json').sort().map(path => [path, sha256(readFileSync(join(stage, ...path.split('/'))))]))
      writeFileSync(join(stage, 'SHA256SUMS.json'), `${JSON.stringify({ algorithm: 'sha256', files: checksums }, null, 2)}\n`)
    }
    const finalDir = join(profileBundles, randomUUID())
    renameSync(stage, finalDir)
    return finalDir
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

function assertProfileMetadataSafe(paths: ProfilePaths): void {
  if (!pathEntryExists(paths.metadata)) return
  assertPlainDirectory(paths.metadata, 'profile .plugin-manager metadata')
  assertNoSymlinksInTree(paths.metadata)
}

function assertProfileStillContained(paths: ProfilePaths): void {
  assertPlainDirectory(paths.profilesRoot, 'DSH profiles root')
  assertPlainDirectory(paths.profileDir, 'DSH profile')
  if (!isWithin(realpathSync(paths.profilesRoot), realpathSync(paths.profileDir))) throw new Error('profile resolves outside the DSH profiles root')
}

function assertInstalledBundleReference(packagePath: string, packageName: string): void {
  assertPlainFile(packagePath, 'installed profile package.json')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>
  } catch {
    throw new Error('DSH install returned success but profile package.json is invalid JSON')
  }
  const dsh = manifest.dsh
  const profile = typeof dsh === 'object' && dsh !== null ? (dsh as Record<string, unknown>).profile : undefined
  const bundles = typeof profile === 'object' && profile !== null ? (profile as Record<string, unknown>).bundles : undefined
  if (!Array.isArray(bundles) || !bundles.includes(packageName)) {
    throw new Error(`DSH install returned success but package.json dsh.profile.bundles does not include ${packageName}`)
  }
}

export function installTransaction(options: InstallTransactionOptions): InstallTransactionResult {
  let profile = options.profileName
  let paths: ProfilePaths | undefined
  let backupDir: string | undefined
  let snapshotRoot: string | undefined
  let privateBundleDir: string | undefined
  let runnerStarted = false
  let output = ''
  let uiToken = ''
  try {
    assertSafeProfileName(options.profileName)
    if (!Number.isInteger(options.uiPort) || options.uiPort < 1024 || options.uiPort > 65535) throw new Error('ui-port must be an integer in [1024, 65535]')
    paths = resolveProfilePaths(options.dshHome, options.profileName)
    assertPlainDirectory(paths.profilesRoot, 'DSH profiles root')
    assertPlainDirectory(paths.profileDir, 'DSH profile')
    if (!isWithin(realpathSync(paths.profilesRoot), realpathSync(paths.profileDir))) throw new Error('profile resolves outside the DSH profiles root')
    assertPlainFile(paths.packageJson, 'profile package.json')
    if (pathEntryExists(paths.metadata)) {
      assertPlainDirectory(paths.metadata, 'profile .plugin-manager metadata')
      assertNoSymlinksInTree(paths.metadata)
    }
    const source = validateSourceBundle(options.sourceBundle)
    const dataDirPath = resolve(options.dataDir)
    const realProfileDir = realpathSync(paths.profileDir)
    const sourceRoot = realpathSync(options.sourceBundle)
    const prospectiveDataDir = prospectiveRealPath(dataDirPath)
    if (isWithin(realProfileDir, prospectiveDataDir) || isWithin(prospectiveDataDir, realProfileDir)) throw new Error('install data directory and DSH profile must not overlap')
    if (isWithin(sourceRoot, prospectiveDataDir) || isWithin(prospectiveDataDir, sourceRoot)) throw new Error('install data directory and source bundle must not overlap')
    mkdirSync(dataDirPath, { recursive: true })
    assertPlainDirectory(dataDirPath, 'install data directory')
    const realDataDir = realpathSync(dataDirPath)
    if (isWithin(realProfileDir, realDataDir) || isWithin(realDataDir, realProfileDir)) throw new Error('install data directory and DSH profile must not overlap')
    if (isWithin(sourceRoot, realDataDir) || isWithin(realDataDir, sourceRoot)) throw new Error('install data directory and source bundle must not overlap')
    uiToken = typeof options.uiToken === 'function' ? options.uiToken() : options.uiToken
    if (!uiToken || /[\r\n]/.test(uiToken)) throw new Error('UI token must be a non-empty single-line value')
    const files = source.files
    const snapshot = createSnapshot(paths, realDataDir, options.profileName)
    backupDir = snapshot.backupDir
    snapshotRoot = snapshot.snapshotRoot
    privateBundleDir = copyBundleToPrivate(sourceRoot, realDataDir, options.profileName, files, source.clientSource, options.uiPort, uiToken)
    runnerStarted = true
    const result = options.runner({ profileName: options.profileName, profileDir: paths.profileDir, privateBundleDir })
    output = result.output.replaceAll(uiToken, '[REDACTED]')
    if (result.code !== 0) throw Object.assign(new Error(`dsh plugin add failed with exit code ${result.code}`), { exitCode: result.code })
    assertProfileStillContained(paths)
    assertInstalledBundleReference(paths.packageJson, source.packageName)
    assertProfileMetadataSafe(paths)
    return { ok: true, profile, privateBundleDir, backupDir, output }
  } catch (error) {
    const rollback = runnerStarted && paths && backupDir && snapshotRoot
      ? rollbackProfile(paths, backupDir, snapshotRoot)
      : { attempted: false, ok: true, errors: [] }
    if (privateBundleDir && rollback.ok) {
      try {
        removeTreeWithoutFollowingLinks(privateBundleDir)
        privateBundleDir = undefined
      } catch (cleanupError) {
        rollback.ok = false
        rollback.errors.push(`private bundle cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
      }
    }
    const failure = error as Error & { exitCode?: number }
    const withoutToken = (text: string): string => uiToken ? text.replaceAll(uiToken, '[REDACTED]') : text
    return {
      ok: false,
      profile,
      exitCode: failure.exitCode && failure.exitCode > 0 ? failure.exitCode : 1,
      error: withoutToken(failure instanceof Error ? failure.message : String(error)),
      output: withoutToken(output),
      ...(backupDir ? { backupDir } : {}),
      ...(privateBundleDir ? { privateBundleDir } : {}),
      rollback,
    }
  }
}
