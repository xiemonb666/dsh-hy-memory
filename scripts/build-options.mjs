import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { isPrivateBundlePath } from './bundle-policy.mjs'
export { isPrivateBundlePath } from './bundle-policy.mjs'

const LEGACY_PACKAGE_FILES = [
  'index.js', 'client.js', 'studio-api.js', 'cli.js', 'studio/**', 'python/**',
  'locale/*.json', 'icon.svg', 'cordis.patch.yml',
]
const CURRENT_PACKAGE_FILES = [
  ...LEGACY_PACKAGE_FILES, 'LICENSE', 'NOTICE', 'SHA256SUMS.json',
]
const ALLOWED_INJECTIONS = [
  ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar'],
  ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-plugin-manager'],
]
const REQUIRED_BUNDLE_FILES = [
  'index.js', 'client.js', 'studio-api.js', 'cli.js', 'cordis.patch.yml', 'icon.svg',
  'studio/index.html', 'python/hymem_worker/__init__.py', 'locale/en.json', 'locale/zh.json',
]
const ALLOWED_TOP_LEVEL = new Set([
  'package.json', 'index.js', 'client.js', 'studio-api.js', 'cli.js', 'cordis.patch.yml',
  'icon.svg', 'studio', 'python', 'locale', 'LICENSE', 'NOTICE', 'SHA256SUMS.json',
])

function isWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate)
  return pathFromParent === '' || (
    pathFromParent !== '..' &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  )
}

function overlaps(left, right) {
  return isWithin(left, right) || isWithin(right, left)
}

function assertNoSymlinkComponents(path) {
  const parsed = parse(path)
  const segments = path.slice(parsed.root.length).split(sep).filter(Boolean)
  let current = parsed.root

  for (const segment of segments) {
    current = join(current, segment)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if (error?.code === 'ENOENT') break
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`Build output path cannot contain a symlink: ${current}`)
    if (current !== path && !stat.isDirectory()) {
      throw new Error(`Build output parent is not a directory: ${current}`)
    }
  }
}

function listRegularFiles(directory, base = directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`Bundle contains a symlink: ${path}`)
    if (entry.isDirectory()) files.push(...listRegularFiles(path, base))
    else if (entry.isFile()) files.push(relative(base, path).split(sep).join('/'))
    else throw new Error(`Bundle contains an unsupported filesystem entry: ${path}`)
  }
  return files.sort()
}

function validateBundleDirectories(directory, base = directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(directory, entry.name)
    const relativePath = relative(base, path).split(sep).join('/')
    const segments = relativePath.split('/')
    if (segments.length === 1 && !['studio', 'python', 'locale'].includes(entry.name)) {
      throw new Error(`bundle contains unrecognized generated content: ${relativePath}/`)
    }
    if (segments[0] === 'locale' && segments.length > 1) {
      throw new Error(`bundle contains unrecognized generated content: ${relativePath}/`)
    }
    validateBundleDirectories(path, base)
  }
}

function matchesPackageFile(file, patterns) {
  return patterns.some(pattern => {
    if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2))
    if (pattern === 'locale/*.json') return /^locale\/[^/]+\.json$/.test(file)
    return file === pattern
  })
}

function verifyBundleManifest(directory, files) {
  const manifestPath = join(directory, 'SHA256SUMS.json')
  if (!existsSync(manifestPath)) return

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new Error('Bundle checksum manifest is invalid JSON')
  }
  if (manifest?.algorithm !== 'sha256' || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('Bundle checksum manifest has an unsupported shape')
  }

  const actualFiles = files.filter(file => file !== 'SHA256SUMS.json')
  const manifestedFiles = Object.keys(manifest.files).sort()
  if (JSON.stringify(manifestedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error('Bundle files do not match its checksum manifest')
  }
  for (const file of actualFiles) {
    const digest = createHash('sha256').update(readFileSync(join(directory, file))).digest('hex')
    if (manifest.files[file] !== digest) throw new Error(`Bundle checksum verification failed for ${file}`)
  }
}

function assertManagedBundle(directory) {
  let packageJson
  try {
    packageJson = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  } catch {
    throw new Error('missing or invalid package.json marker')
  }
  if (packageJson?.name !== 'dsh-hy-memory') throw new Error('package.json is not a dsh-hy-memory bundle marker')
  if (packageJson?.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('bundle patch metadata is not recognized')

  const packageFiles = packageJson.files
  const hasKnownFileList = Array.isArray(packageFiles) && [LEGACY_PACKAGE_FILES, CURRENT_PACKAGE_FILES].some(known => (
    packageFiles.length === known.length && known.every(pattern => packageFiles.includes(pattern))
  ))
  if (!hasKnownFileList) throw new Error('package.json has an unrecognized generated file allowlist')
  if (!ALLOWED_INJECTIONS.some(injections => JSON.stringify(packageJson?.dsh?.client?.inject) === JSON.stringify(injections))) {
    throw new Error('client injection metadata is not recognized')
  }

  validateBundleDirectories(directory)
  const files = listRegularFiles(directory)
  for (const file of files) {
    if (isPrivateBundlePath(file)) {
      throw new Error(`bundle contains a private environment file or data: ${file}`)
    }
    const topLevel = file.split('/')[0]
    if (!ALLOWED_TOP_LEVEL.has(topLevel) || (file !== 'package.json' && !matchesPackageFile(file, packageFiles))) {
      throw new Error(`bundle contains unrecognized generated content: ${file}`)
    }
  }
  for (const required of REQUIRED_BUNDLE_FILES) {
    if (!files.includes(required)) throw new Error(`bundle is missing required generated file: ${required}`)
  }
  if (packageFiles.includes('LICENSE') && !files.includes('LICENSE')) throw new Error('bundle is missing LICENSE')
  if (packageFiles.includes('NOTICE') && !files.includes('NOTICE')) throw new Error('bundle is missing NOTICE')
  verifyBundleManifest(directory, files)
  return files
}

export function validateBuildOutput(path, {
  repoRoot,
  home = homedir(),
  temp = tmpdir(),
  environment = process.env,
} = {}) {
  if (!isAbsolute(path)) throw new Error(`Build output must be an absolute path: ${path}`)

  const output = resolve(path)
  const repository = resolve(repoRoot)
  const filesystemRoot = parse(output).root
  if (output === filesystemRoot) throw new Error(`Refusing to use a filesystem root as build output: ${output}`)
  if (isWithin(output, repository)) {
    throw new Error(`Refusing to use the repository root or its parent as build output: ${output}`)
  }

  const generatedRoots = ['dist', 'artifacts'].map(name => join(repository, name))
  const isGeneratedChild = generatedRoots.some(root => output !== root && isWithin(root, output))
  if (isWithin(repository, output) && !isGeneratedChild) {
    if (output === join(repository, 'artifacts')) throw new Error(`Refusing to use the artifact root as build output: ${output}`)
    throw new Error(`Build output inside the repository must be a child of dist or artifacts, not a source directory: ${output}`)
  }

  const protectedSourceRoots = [
    'packages', 'scripts', 'python', 'tests', '.github', '.git', 'node_modules',
    '.pnpm-store', '.upstream', 'data',
  ].map(name => join(repository, name))
  for (const sourceRoot of protectedSourceRoots) {
    if (overlaps(output, sourceRoot)) {
      throw new Error(`Build output overlaps a protected source or workspace directory: ${output}`)
    }
  }

  const temporary = resolve(temp)
  const protectedExternalRoots = [
    home,
    environment.APPDATA,
    environment.LOCALAPPDATA,
    environment.SystemRoot,
    environment.ProgramFiles,
    environment['ProgramFiles(x86)'],
  ].filter(Boolean).map(root => resolve(root))
  for (const protectedRoot of protectedExternalRoots) {
    if (overlaps(protectedRoot, output) && !isWithin(temporary, output) && !isWithin(repository, output)) {
      throw new Error(`Build output is inside a protected user or system directory: ${output}`)
    }
  }

  assertNoSymlinkComponents(output)
  recoverPublication(output)
  try {
    const entries = readdirSync(output)
    if (entries.length > 0) {
      try {
        assertManagedBundle(output)
      } catch (error) {
        throw new Error(`Build output is nonempty and is not a recognized HyMemory bundle: ${output} (${error.message})`)
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  return output
}

export function parseBuildOptions(args, options) {
  const { repoRoot } = options ?? {}
  if (!repoRoot) throw new Error('A fixed repository root is required to parse build options')

  let output = join(repoRoot, 'dist', 'bundle')
  let sawOutput = false
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option !== '--out') throw new Error(`Unknown build option: ${option}`)
    if (sawOutput) throw new Error('--out may be specified only once')
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error('--out requires an absolute directory path')
    if (!isAbsolute(value)) throw new Error(`Build output must be an absolute path: ${value}`)
    output = value
    sawOutput = true
    index += 1
  }

  return { out: validateBuildOutput(output, options) }
}

function publicationJournal(output) {
  return join(dirname(output), `.${basename(output)}.hymem-publish.json`)
}

function atomicCopy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true })
  const temporary = join(dirname(destination), `.dsh-hymem-publish-${randomUUID()}`)
  try {
    copyFileSync(source, temporary)
    renameSync(temporary, destination)
  } catch (error) {
    try { unlinkSync(temporary) } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'Build file copy and cleanup failed')
    }
    throw error
  }
}

function pruneEmptyGeneratedDirectories(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const child = join(directory, entry.name)
    pruneEmptyGeneratedDirectories(child)
    if (readdirSync(child).length === 0) rmdirSync(child)
  }
}

function recoverPublication(output, allowCurrentProcess = false) {
  const journal = publicationJournal(output)
  if (!existsSync(journal)) return
  assertNoSymlinkComponents(journal)
  const state = JSON.parse(readFileSync(journal, 'utf8'))
  if (state.version !== 1 || state.output !== output || !Number.isSafeInteger(state.pid) || state.pid <= 0
    || typeof state.hadFiles !== 'boolean' || typeof state.backup !== 'string' || !Array.isArray(state.stagedFiles)) {
    throw new Error(`Invalid build recovery journal: ${journal}`)
  }
  if (state.pid !== process.pid || !allowCurrentProcess) {
    try {
      process.kill(state.pid, 0)
      throw new Error(`Build publisher ${state.pid} is still active; refusing recovery`)
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  const backup = resolve(state.backup)
  if (dirname(backup) !== dirname(output) || !/^\.dsh-hymem-rollback-[A-Za-z0-9]+$/.test(basename(backup))) {
    throw new Error('Build recovery backup is outside its managed sibling directory')
  }
  assertNoSymlinkComponents(backup)
  if (state.hadFiles !== (readdirSync(backup).length > 0)) throw new Error('Build recovery journal contradicts its retained backup; refusing changes')
  const oldFiles = state.hadFiles === true ? assertManagedBundle(backup) : []
  for (const file of state.stagedFiles) {
    if (typeof file !== 'string' || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(file)
      || !ALLOWED_TOP_LEVEL.has(file.split('/')[0]) || isPrivateBundlePath(file)) {
      throw new Error('Build recovery journal contains an unsafe file path')
    }
  }
  const oldSet = new Set(oldFiles)
  for (const file of state.stagedFiles) {
    if (!oldSet.has(file)) {
      try { unlinkSync(join(output, file)) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
  }
  for (const file of oldFiles) atomicCopy(join(backup, file), join(output, file))
  if (existsSync(output)) {
    for (const file of listRegularFiles(output)) {
      if (/^\.dsh-hymem-publish-[0-9a-f-]{36}$/i.test(basename(file))) unlinkSync(join(output, file))
    }
    pruneEmptyGeneratedDirectories(output)
  }
  if (oldFiles.length > 0) assertManagedBundle(output)
  unlinkSync(journal)
  rmSync(backup, { recursive: true, force: true })
}

export function publishBuildOutput(stagedDirectory, outputPath, options, { beforePublish } = {}) {
  const stage = resolve(stagedDirectory)
  const output = validateBuildOutput(outputPath, options)
  if (overlaps(stage, output)) throw new Error('Staging directory and build output must be separate paths')
  const stagedFiles = assertManagedBundle(stage)
  const existingFiles = existsSync(output) ? (() => {
    const entries = readdirSync(output)
    return entries.length === 0 ? [] : assertManagedBundle(output)
  })() : []
  const stagedSet = new Set(stagedFiles)
  mkdirSync(dirname(output), { recursive: true })
  const backup = mkdtempSync(join(dirname(output), '.dsh-hymem-rollback-'))
  const journal = publicationJournal(output)
  try {
    for (const file of existingFiles) {
      mkdirSync(dirname(join(backup, file)), { recursive: true })
      copyFileSync(join(output, file), join(backup, file))
    }
    writeFileSync(journal, JSON.stringify({ version: 1, pid: process.pid, output, backup, hadFiles: existingFiles.length > 0, stagedFiles }), { flag: 'wx' })
  } catch (error) {
    rmSync(backup, { recursive: true, force: true })
    throw error
  }
  try {
    mkdirSync(output, { recursive: true })
    for (const file of stagedFiles.sort((left, right) => {
    if (left === 'SHA256SUMS.json') return 1
    if (right === 'SHA256SUMS.json') return -1
    return left.localeCompare(right)
    })) {
      beforePublish?.(file)
      atomicCopy(join(stage, file), join(output, file))
    }
    for (const file of existingFiles) {
      if (!stagedSet.has(file)) unlinkSync(join(output, file))
    }
    assertManagedBundle(output)
    unlinkSync(journal)
    rmSync(backup, { recursive: true, force: true })
    return output
  } catch (error) {
    try { recoverPublication(output, true) } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], `Build publication failed; recovery evidence retained at ${journal}`)
    }
    throw error
  }
}
