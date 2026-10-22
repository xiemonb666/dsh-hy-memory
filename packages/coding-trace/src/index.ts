/**
 * Read-only coding trace helpers for DSH HyMemory.
 *
 * The package turns a workspace into a stable identity, probes git state,
 * evaluates whether a code binding is still trustworthy, and builds the
 * change/revert chain used by recall to avoid recommending reverted work.
 *
 * Every function is pure with respect to the repository: git is only read
 * (`rev-parse`, `status`, `log`, `merge-base`, `remote get-url`). The single
 * write is `<git-dir>/dsh-hy-memory-workspace-id`, created only when absent and
 * never when a canonical remote already identifies the workspace. No network
 * access is performed.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { sha256 } from '@dsh-hy-memory/contracts'

/** Default per-git-command timeout. */
const DEFAULT_GIT_TIMEOUT_MS = 5_000

/** Ref pattern that cannot be mistaken for a git option or shell fragment. */
const SAFE_REF_RE = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/@{}~^:+-]*$/

/** Commits whose subject matches this are reverts. */
const REVERT_SHA_RE = /This reverts commit ([0-9a-f]{7,40})\b/i
const REVERT_QUOTED_RE = /^\s*Revert\s+"/m

/** Keywords that look like C/C++ calls but are control flow, not declarations. */
const CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'sizeof',
  'else',
  'do',
  'try',
  'new',
  'delete',
  'throw',
])

/** Options shared by every git invocation. */
export interface GitOptions {
  root: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/** Options for {@link probeGit}. */
export interface ProbeOptions {
  /** Commit whose merge-base with HEAD becomes `baseCommit`. */
  baseCommit?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/** Options for {@link fingerprintWorkspace}. */
export interface FingerprintOptions {
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/** Snapshot of the repository state at probe time. */
export interface GitProbe {
  root: string
  branch: string | null
  headCommit: string | null
  baseCommit: string | null
  dirty: boolean
  changedFiles: string[]
  shallow: boolean
  detached: boolean
  remote: string | null
}

/** Stable workspace identity plus the current git state. */
export interface WorkspaceFingerprint {
  repoFingerprint: string
  rootAlias: string
  remote?: string
  headCommit?: string
  branch?: string
  shallow: boolean
  detached: boolean
  dirty: boolean
}

/** One file recorded by a code binding. */
export interface BoundFile {
  path: string
  /** Content sha256 captured when the binding was written. */
  hash?: string | null
}

/** Binding fields relevant to freshness (a projection of a code binding row). */
export interface CodeBindingSnapshot {
  workspaceId?: string
  branch?: string | null
  baseCommit?: string | null
  headCommit?: string | null
  files?: BoundFile[]
  filePath?: string | null
  fileHash?: string | null
}

/** Current workspace fields relevant to freshness. */
export interface WorkspaceSnapshot {
  repoFingerprint?: string
  branch?: string | null
  headCommit?: string | null
  shallow?: boolean
  detached?: boolean
  dirty?: boolean
  changedFiles?: string[]
  /** Current hashes for files of interest (avoids disk reads). */
  files?: BoundFile[]
}

/** Options for {@link evaluateFreshness}. */
export interface FreshnessOptions {
  /** Repository root; enables git-based ancestor/revert detection. */
  root?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Custom file reader; must return `null` when the file does not exist. */
  readFileHash?: (relativePath: string) => string | null
  /** Custom ancestor check (defaults to git when `root` is set). */
  isAncestor?: (ancestor: string, descendant: string) => boolean
  /** Custom merge-base check; `null` means the histories are unrelated. */
  mergeBase?: (left: string, right: string) => string | null
  /** Files changed since the binding (e.g. `git diff --name-only base..head`). */
  changedFiles?: string[]
  /** Commits known to be reverted in the range. */
  revertedCommits?: string[]
}

/** Freshness verdict for a code binding. */
export type FreshnessState = 'fresh' | 'conditional' | 'stale' | 'unknown'

/** Freshness verdict plus machine-readable reasons. */
export interface FreshnessResult {
  state: FreshnessState
  reasons: string[]
}

/** One commit in a diff chain. */
export interface DiffEvent {
  commit: string
  parent?: string | null
  message: string
  files?: string[]
  symbols?: string[]
  patch?: string
  patchHash?: string
  tests?: string[]
}

/** One ordered node of a diff chain. */
export interface DiffChainNode {
  commit: string
  kind: 'change' | 'revert'
  files: string[]
  symbols?: string[]
  patchHash?: string
  tests?: string[]
}

/** Ordered change/revert chain between a base and a head commit. */
export interface DiffChain {
  baseCommit: string | null
  headCommit: string | null
  nodes: DiffChainNode[]
  /** Commit ids that were reverted inside the chain; recall must not recommend them. */
  reverted: string[]
}

/** A symbol-like token extracted from a unified diff. */
export interface DiffSymbol {
  file: string
  symbol: string
  kind: 'hunk' | 'declaration'
}

/** Best-effort result of {@link symbolsFromDiff}. */
export interface DiffSymbols {
  files: string[]
  symbols: DiffSymbol[]
}

function statusOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status
    return typeof status === 'number' ? status : null
  }
  return null
}

/**
 * Validate a git ref before passing it as an argv element. Prevents option
 * injection (`--upload-pack=...`) and argument smuggling.
 * @param ref - user/binding supplied commit or branch name.
 * @returns the same ref when safe.
 */
export function assertSafeGitRef(ref: string): string {
  if (!SAFE_REF_RE.test(ref)) throw new Error(`unsafe git ref: ${JSON.stringify(ref)}`)
  return ref
}

function runGit(options: GitOptions, args: readonly string[], allowFailure = true): Buffer | null {
  try {
    return execFileSync('git', ['--no-pager', '-C', options.root, ...args], {
      timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(options.env ? { env: options.env } : {}),
    })
  } catch (error) {
    if (allowFailure) return null
    throw error instanceof Error ? error : new Error(String(error))
  }
}

function runGitStatus(options: GitOptions, args: readonly string[]): number {
  try {
    execFileSync('git', ['--no-pager', '-C', options.root, ...args], {
      timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      ...(options.env ? { env: options.env } : {}),
    })
    return 0
  } catch (error) {
    return statusOf(error) ?? 127
  }
}

function gitText(options: GitOptions, args: readonly string[]): string | null {
  const output = runGit(options, args)
  if (!output) return null
  const text = output.toString('utf8').trim()
  return text.length > 0 ? text : null
}

/**
 * Raw git output without trimming: `git status --porcelain` encodes the two
 * status columns verbatim, so a leading space on the first line is meaningful.
 */
function gitRawText(options: GitOptions, args: readonly string[]): string | null {
  const output = runGit(options, args)
  if (!output) return null
  const text = output.toString('utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '')
  return text.length > 0 ? text : null
}

function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value
  return value
    .slice(1, -1)
    .replace(/\\(["\\])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
}

function parsePorcelain(text: string): string[] {
  const files: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 4) continue
    const body = line.slice(3).trim()
    if (body.length === 0) continue
    const arrow = body.indexOf(' -> ')
    files.push(unquoteGitPath(arrow >= 0 ? body.slice(arrow + 4) : body))
  }
  return files
}

/**
 * Probe the repository state with read-only git commands.
 * @param root - repository root (any directory inside the worktree).
 * @param options - optional merge-base commit, timeout and environment.
 * @returns branch, head, merge-base, dirty state, changed files, shallow/detached flags and origin.
 */
export function probeGit(root: string, options: ProbeOptions = {}): GitProbe {
  const gitOptions: GitOptions = {
    root,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.env ? { env: options.env } : {}),
  }
  const branch = gitText(gitOptions, ['symbolic-ref', '--short', '-q', 'HEAD'])
  const headCommit = gitText(gitOptions, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const detached = headCommit !== null && branch === null
  const shallow = gitText(gitOptions, ['rev-parse', '--is-shallow-repository']) === 'true'
  const remote = gitText(gitOptions, ['remote', 'get-url', 'origin'])
  const statusText = gitRawText(gitOptions, ['status', '--porcelain'])
  const changedFiles = statusText ? parsePorcelain(statusText) : []
  let baseCommit: string | null = null
  if (options.baseCommit) {
    baseCommit = gitText(gitOptions, ['merge-base', assertSafeGitRef(options.baseCommit), 'HEAD'])
  }
  return {
    root,
    branch,
    headCommit,
    baseCommit,
    dirty: changedFiles.length > 0,
    changedFiles,
    shallow,
    detached,
    remote,
  }
}

/**
 * True when `ancestor` is reachable from `descendant`.
 * @param ancestor - candidate ancestor commit.
 * @param descendant - candidate descendant commit.
 * @param options - repository root and git invocation options.
 * @returns `true`/`false`; throws only for real git failures (not for a
 * non-ancestor result).
 */
export function isAncestor(ancestor: string, descendant: string, options: GitOptions): boolean {
  const status = runGitStatus(options, [
    'merge-base',
    '--is-ancestor',
    assertSafeGitRef(ancestor),
    assertSafeGitRef(descendant),
  ])
  if (status === 0) return true
  if (status === 1) return false
  throw new Error(`git merge-base --is-ancestor failed with exit code ${status}`)
}

/**
 * Canonicalize a git remote URL so the same repository has one stable identity.
 * Hostnames are lowercased, credentials/search/hash are dropped, `.git` and
 * trailing slashes are removed, and scp-like syntax becomes `ssh://`.
 * @param remote - raw `origin` URL.
 * @returns canonical remote, or `''` for an empty input.
 */
export function canonicalRemote(remote: string): string {
  let value = remote.trim()
  if (value.length === 0) return ''
  const scpLike = /^(?:([^@/:\s]+)@)?([^/:\s]+):(?!\/)(.+)$/.exec(value)
  if (scpLike && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    value = `ssh://${scpLike[1] ? `${scpLike[1]}@` : ''}${scpLike[2]}/${scpLike[3]}`
  }
  try {
    const url = new URL(value)
    url.hash = ''
    url.search = ''
    url.password = ''
    url.protocol = url.protocol.toLowerCase()
    url.hostname = url.hostname.toLowerCase()
    if (
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'ssh:' && url.port === '22')
    ) {
      url.port = ''
    }
    const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
    // SSH usernames are part of the repository identity; HTTP(S) credentials
    // are secrets and must never end up in a fingerprint input.
    const userinfo = url.protocol === 'ssh:' && url.username ? `${url.username}@` : ''
    return `${url.protocol}//${userinfo}${url.host}${path}`
  } catch {
    return value.replace(/\/+$/, '').replace(/\.git$/i, '')
  }
}

function gitDirOf(root: string, options: GitOptions): string | null {
  const absolute = gitText(options, ['rev-parse', '--absolute-git-dir'])
  if (!absolute) return null
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

function readOrCreateWorkspaceId(gitDir: string): string {
  const file = join(gitDir, 'dsh-hy-memory-workspace-id')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing.length > 0) return existing
  } catch {
    // File is absent: create it below.
  }
  const id = randomUUID()
  try {
    writeFileSync(file, `${id}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST')) throw error
    const raced = readFileSync(file, 'utf8').trim()
    if (raced.length > 0) return raced
    writeFileSync(file, `${id}\n`, { encoding: 'utf8' })
  }
  return id
}

/**
 * Compute the stable workspace identity.
 *
 * With an `origin` remote the fingerprint is `sha256(canonicalRemote + realpath)`;
 * without one it is `sha256(workspaceId + realpath)` where the workspace id is a
 * random UUID persisted in `<git-dir>/dsh-hy-memory-workspace-id` (created only
 * when absent; no other git file is touched).
 * @param root - repository root.
 * @param options - git timeout/environment.
 * @returns stable fingerprint, path alias and current git state.
 */
export function fingerprintWorkspace(root: string, options: FingerprintOptions = {}): WorkspaceFingerprint {
  const absoluteRoot = resolve(root)
  if (!existsSync(absoluteRoot)) throw new Error(`workspace root does not exist: ${root}`)
  const realRoot = realpathSync.native(absoluteRoot)
  const gitOptions: GitOptions = {
    root: realRoot,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.env ? { env: options.env } : {}),
  }
  const topLevel = gitText(gitOptions, ['rev-parse', '--show-toplevel'])
  let repoRoot = realRoot
  if (topLevel) {
    try {
      repoRoot = realpathSync.native(topLevel)
    } catch {
      repoRoot = topLevel
    }
  }
  const probe = probeGit(repoRoot, options)
  const remote = probe.remote ? canonicalRemote(probe.remote) : undefined

  let repoFingerprint: string
  if (remote) {
    repoFingerprint = sha256(`remote\u0000${remote}\u0000${repoRoot}`)
  } else {
    const gitDir = gitDirOf(repoRoot, { ...gitOptions, root: repoRoot })
    if (!gitDir) throw new Error(`not a git repository: ${root}`)
    const workspaceId = readOrCreateWorkspaceId(gitDir)
    repoFingerprint = sha256(`local\u0000${workspaceId}\u0000${repoRoot}`)
  }

  return {
    repoFingerprint,
    rootAlias: `${basename(repoRoot)}#${repoFingerprint.slice(0, 8)}`,
    ...(remote ? { remote } : {}),
    ...(probe.headCommit ? { headCommit: probe.headCommit } : {}),
    ...(probe.branch ? { branch: probe.branch } : {}),
    shallow: probe.shallow,
    detached: probe.detached,
    dirty: probe.dirty,
  }
}

/**
 * Content sha256 of a file, used for binding/file comparisons.
 * @param path - absolute file path.
 * @returns hex digest, or `null` when the file does not exist.
 */
export function fileContentHash(path: string): string | null {
  try {
    return sha256(readFileSync(path))
  } catch {
    return null
  }
}

function sameCommit(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  if (a.length < 7 || b.length < 7) return false
  return a === b || a.startsWith(b) || b.startsWith(a)
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * Detect reverted commit ids inside a range by scanning commit messages for
 * `This reverts commit <sha>` (git's default revert body).
 * @param root - repository root.
 * @param from - exclusive lower bound.
 * @param to - inclusive upper bound.
 * @param options - git timeout/environment.
 * @returns reverted commit ids (as written in the messages).
 */
export function revertedCommitsInRange(
  root: string,
  from: string,
  to: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const gitOptions: GitOptions = {
    root,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.env ? { env: options.env } : {}),
  }
  const range = `${assertSafeGitRef(from)}..${assertSafeGitRef(to)}`
  const text = gitText(gitOptions, ['log', '--format=%H%x1f%B%x1e', range])
  if (!text) return []
  const targets: string[] = []
  for (const record of text.split('\u001e')) {
    const [, body = ''] = record.split('\u001f')
    const match = REVERT_SHA_RE.exec(body)
    if (match?.[1]) targets.push(match[1])
  }
  return dedupeStrings(targets)
}

function boundFilesOf(binding: CodeBindingSnapshot): BoundFile[] {
  if (binding.files && binding.files.length > 0) return binding.files
  if (binding.filePath) return [{ path: binding.filePath, hash: binding.fileHash ?? null }]
  return []
}

function currentHashOf(
  file: BoundFile,
  current: WorkspaceSnapshot,
  options: FreshnessOptions,
): string | null | undefined {
  const listed = current.files?.find(item => item.path === file.path)
  if (listed) return listed.hash ?? null
  if (options.readFileHash) return options.readFileHash(file.path)
  if (options.root) return fileContentHash(join(options.root, file.path))
  return undefined
}

function mergeBaseOf(
  left: string,
  right: string,
  options: FreshnessOptions,
): string | null | undefined {
  if (options.mergeBase) return options.mergeBase(left, right)
  if (!options.root) return undefined
  const gitOptions: GitOptions = {
    root: options.root,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.env ? { env: options.env } : {}),
  }
  return gitText(gitOptions, ['merge-base', assertSafeGitRef(left), assertSafeGitRef(right)])
}

/**
 * Evaluate whether a code binding is still applicable to the current workspace.
 *
 * Rules (engineering plan §6.3):
 * - `unknown` when the clone is shallow, HEAD is detached, or head/binding data
 *   is missing;
 * - `stale` when the bound head is not an ancestor of the current head, when
 *   branches diverged without a shared base, when a bound file's content hash
 *   changed (or the file disappeared), or when the bound commit was reverted in
 *   the range;
 * - `conditional` when only unrelated files changed and bound files did not;
 * - `fresh` when the bound commit is an ancestor and bound files are unchanged.
 * @param binding - persisted code binding snapshot.
 * @param current - current workspace snapshot (from `probeGit`/`fingerprintWorkspace`).
 * @param options - root/callbacks/changed files/reverted commits.
 * @returns verdict plus reasons.
 */
export function evaluateFreshness(
  binding: CodeBindingSnapshot,
  current: WorkspaceSnapshot,
  options: FreshnessOptions = {},
): FreshnessResult {
  const reasons: string[] = []

  if (binding.workspaceId && current.repoFingerprint && binding.workspaceId !== current.repoFingerprint) {
    return { state: 'unknown', reasons: ['workspace_mismatch'] }
  }
  if (current.shallow) return { state: 'unknown', reasons: ['shallow_repository'] }
  if (current.detached) return { state: 'unknown', reasons: ['detached_head'] }

  const currentHead = current.headCommit ?? null
  if (!currentHead) return { state: 'unknown', reasons: ['missing_current_head'] }
  const boundHead = binding.headCommit ?? binding.baseCommit ?? null
  if (!boundHead) return { state: 'unknown', reasons: ['missing_binding_commit'] }

  const ancestorCheck =
    options.isAncestor ??
    (options.root
      ? (ancestor: string, descendant: string): boolean =>
          isAncestor(ancestor, descendant, {
            root: options.root as string,
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.env ? { env: options.env } : {}),
          })
      : undefined)

  let ancestor: boolean
  if (sameCommit(boundHead, currentHead)) {
    ancestor = true
  } else if (ancestorCheck) {
    ancestor = ancestorCheck(boundHead, currentHead)
  } else {
    return { state: 'unknown', reasons: ['ancestor_check_unavailable'] }
  }
  if (!ancestor) {
    reasons.push('bound_commit_not_ancestor')
    if (binding.branch && current.branch && binding.branch !== current.branch) reasons.push('branch_changed')
    return { state: 'stale', reasons }
  }

  if (binding.branch && current.branch && binding.branch !== current.branch) {
    reasons.push('branch_changed')
    const shared = mergeBaseOf(boundHead, currentHead, options)
    if (shared === null) {
      reasons.push('branch_diverged_without_shared_base')
      return { state: 'stale', reasons }
    }
  }

  let reverted = options.revertedCommits
  if (!reverted && options.root && !sameCommit(boundHead, currentHead)) {
    try {
      reverted = revertedCommitsInRange(options.root, boundHead, currentHead, {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.env ? { env: options.env } : {}),
      })
    } catch {
      reverted = []
    }
  }
  if (reverted && reverted.some(commit => sameCommit(commit, boundHead) || sameCommit(commit, binding.baseCommit))) {
    reasons.push('bound_commit_reverted')
    return { state: 'stale', reasons }
  }

  const boundFiles = boundFilesOf(binding)
  for (const file of boundFiles) {
    const currentHash = currentHashOf(file, current, options)
    if (currentHash === undefined) {
      return { state: 'unknown', reasons: [...reasons, `missing_current_hash:${file.path}`] }
    }
    if (currentHash === null) {
      return { state: 'stale', reasons: [...reasons, `bound_file_missing:${file.path}`] }
    }
    if (file.hash && currentHash !== file.hash) {
      return { state: 'stale', reasons: [...reasons, `bound_file_changed:${file.path}`] }
    }
  }

  const changedFiles = options.changedFiles ?? current.changedFiles ?? []
  const touchedBoundFiles = boundFiles.filter(file => changedFiles.includes(file.path)).map(file => file.path)
  if (touchedBoundFiles.length > 0) {
    // A bound file changed after the binding. With a recorded hash we already
    // compared content above and could prove it unchanged; without one the
    // honest verdict is "cannot prove it still applies", never `fresh`.
    const hashed = boundFiles.some(file => typeof file.hash === 'string' && file.hash.length > 0)
    if (hashed) {
      reasons.push('bound_file_touched_but_unchanged')
      return { state: 'fresh', reasons }
    }
    reasons.push('bound_file_touched_hash_unknown')
    return { state: 'conditional', reasons }
  }
  // Unrelated files changing does not invalidate a conclusion about the bound
  // files, but it does mean the workspace moved: report `conditional` so the
  // memory is shown with its preconditions instead of being presented as
  // unconditionally fresh.
  const unrelated = changedFiles.filter(path => !boundFiles.some(file => file.path === path))
  if (unrelated.length > 0) {
    reasons.push('unrelated_files_changed')
    return { state: 'conditional', reasons }
  }

  reasons.push('bound_commit_ancestor', 'bound_files_unchanged')
  return { state: 'fresh', reasons }
}

function parseDiffFileHeader(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed === '/dev/null') return null
  const unquoted = unquoteGitPath(trimmed)
  return unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted.startsWith('a/') ? unquoted.slice(2) : unquoted
}

function declarationSymbol(line: string): string | null {
  const text = line.trim()
  if (text.length === 0) return null
  if (text.startsWith('//') || text.startsWith('/*') || text.startsWith('*') || text.startsWith('#')) return null

  let match = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(text)
  if (match?.[1]) return match[1]
  match = /^class\s+([A-Za-z_]\w*)/.exec(text)
  if (match?.[1]) return match[1]
  match = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]/.exec(text)
  if (match?.[1]) return match[1]
  match = /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(text)
  if (match?.[1]) return match[1]
  match = /^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(text)
  if (match?.[1]) return match[1]
  match = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(text)
  if (match?.[1]) return match[1]
  match = /^(?:[\w:<>,*&]+\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:\{|$)/.exec(text)
  if (match?.[1] && !CONTROL_KEYWORDS.has(match[1])) return match[1]
  return null
}

/**
 * Best-effort symbol extraction from a unified diff.
 *
 * This is deliberately heuristic: changed file paths, hunk headers (with their
 * trailing context) and function-ish declarations from context/added lines. It
 * is **not** an AST parser and must not be presented as semantic precision.
 * @param patch - unified diff text.
 * @returns changed files and hunk/declaration symbols.
 */
export function symbolsFromDiff(patch: string): DiffSymbols {
  const files: string[] = []
  const symbols: DiffSymbol[] = []
  let currentFile: string | null = null
  let inHunk = false
  const seen = new Set<string>()

  const push = (file: string, symbol: string, kind: DiffSymbol['kind']): void => {
    const key = `${file}\u0000${kind}\u0000${symbol}`
    if (seen.has(key)) return
    seen.add(key)
    symbols.push({ file, symbol, kind })
  }

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      currentFile = null
      inHunk = false
      continue
    }
    if (line.startsWith('+++ ')) {
      currentFile = parseDiffFileHeader(line.slice(4))
      if (currentFile) files.push(currentFile)
      inHunk = false
      continue
    }
    if (line.startsWith('--- ')) continue
    const hunk = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@\s*(.*)$/.exec(line)
    if (hunk) {
      inHunk = true
      if (currentFile) push(currentFile, hunk[1]?.trim() || line.trim(), 'hunk')
      continue
    }
    if (!currentFile || !inHunk) continue
    const marker = line.charAt(0)
    if (marker !== ' ' && marker !== '+' && marker !== '-') continue
    const symbol = declarationSymbol(line.slice(1))
    if (symbol) push(currentFile, symbol, 'declaration')
  }

  return { files: dedupeStrings(files), symbols }
}

function isRevertMessage(message: string): boolean {
  return REVERT_SHA_RE.test(message) || REVERT_QUOTED_RE.test(message)
}

function revertTargetOf(message: string): string | null {
  return REVERT_SHA_RE.exec(message)?.[1] ?? null
}

function orderEvents(events: readonly DiffEvent[]): DiffEvent[] {
  const known = new Set(events.map(event => event.commit))
  const emitted = new Set<string>()
  const ordered: DiffEvent[] = []
  let progressed = true
  while (ordered.length < events.length && progressed) {
    progressed = false
    for (const event of events) {
      if (emitted.has(event.commit)) continue
      if (event.parent && known.has(event.parent) && !emitted.has(event.parent)) continue
      ordered.push(event)
      emitted.add(event.commit)
      progressed = true
    }
  }
  for (const event of events) {
    if (!emitted.has(event.commit)) ordered.push(event)
  }
  return ordered
}

/**
 * Build an ordered change/revert chain from commit events.
 *
 * Events are ordered by their `parent` links (input order breaks ties), revert
 * commits are marked `kind: 'revert'`, and their target ids are collected in
 * `reverted` so recall can avoid recommending reverted work.
 * @param events - commit events, in any order.
 * @returns base/head commits, ordered nodes and reverted commit ids.
 */
export function buildDiffChain(events: readonly DiffEvent[]): DiffChain {
  const unique = new Map<string, DiffEvent>()
  for (const event of events) {
    if (!unique.has(event.commit)) unique.set(event.commit, event)
  }
  const ordered = orderEvents([...unique.values()])
  const reverted: string[] = []

  const nodes: DiffChainNode[] = ordered.map(event => {
    const fromPatch = event.patch ? symbolsFromDiff(event.patch) : undefined
    const files = dedupeStrings(event.files ?? fromPatch?.files ?? [])
    const symbols = event.symbols ?? fromPatch?.symbols.map(symbol => symbol.symbol) ?? []
    const patchHash = event.patchHash ?? (event.patch ? sha256(event.patch) : undefined)
    const kind: DiffChainNode['kind'] = isRevertMessage(event.message) ? 'revert' : 'change'
    const target = revertTargetOf(event.message)
    if (target) reverted.push(target)
    return {
      commit: event.commit,
      kind,
      files,
      ...(symbols.length > 0 ? { symbols: dedupeStrings(symbols) } : {}),
      ...(patchHash ? { patchHash } : {}),
      ...(event.tests && event.tests.length > 0 ? { tests: event.tests } : {}),
    }
  })

  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  return {
    baseCommit: first ? (first.parent ?? first.commit) : null,
    headCommit: last ? last.commit : null,
    nodes,
    reverted: dedupeStrings(reverted),
  }
}
