/**
 * Workspace identity resolution.
 *
 * A project is a stable governance scope derived from the repository identity,
 * never from a display path: canonical remote + repo-root fingerprint when a
 * remote exists, otherwise a persisted random UUID stored inside `.git`.
 * Display paths are aliases only.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'

export interface WorkspaceIdentity {
  projectId: string
  workspaceId: string
  repoFingerprint: string
  rootAlias: string
  remote?: string
  branch?: string
  headCommit?: string
  dirty?: boolean
  shallow?: boolean
  detached?: boolean
}

function git(root: string, args: string[], timeout = 5000): string | null {
  try {
    const output = execFileSync('git', ['--no-pager', ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    return output.trim()
  } catch {
    return null
  }
}

/**
 * Resolve a stable workspace identity for a directory. Falls back to a local
 * synthetic workspace when the directory is not a git repository so capture
 * still works for scratch sessions.
 * @param cwd - directory to inspect.
 * @returns stable ids plus git facts.
 */
export function resolveWorkspaceIdentity(cwd: string): WorkspaceIdentity {
  let root = cwd
  try {
    root = realpathSync(cwd)
  } catch {
    // Keep the provided path when it cannot be resolved (e.g. removed dir).
  }
  const top = git(root, ['rev-parse', '--show-toplevel'])
  const repoRoot = top && top.length > 0 ? top : root
  const remote = git(repoRoot, ['config', '--get', 'remote.origin.url'])
  let fingerprint: string
  if (remote) {
    fingerprint = createHash('sha256').update(`remote:${remote}\u0000${repoRoot}`).digest('hex').slice(0, 32)
  } else {
    const idFile = join(repoRoot, '.git', 'dsh-hy-memory-workspace-id')
    try {
      if (existsSync(idFile)) {
        const stored = readFileSync(idFile, 'utf8').trim()
        fingerprint = stored.length >= 32 ? stored : `local:${randomUUID()}`
      } else {
        const generated = `local:${randomUUID()}`
        writeFileSync(idFile, `${generated}\n`, { encoding: 'utf8', mode: 0o600 })
        fingerprint = generated
      }
    } catch {
      fingerprint = `local:${createHash('sha256').update(repoRoot).digest('hex').slice(0, 32)}`
    }
  }
  const branch = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? undefined
  const headCommit = git(repoRoot, ['rev-parse', 'HEAD']) ?? undefined
  const status = git(repoRoot, ['status', '--porcelain'])
  const shallow = git(repoRoot, ['rev-parse', '--is-shallow-repository']) === 'true'
  const detached = branch === 'HEAD'
  return {
    projectId: `project_${createHash('sha256').update(fingerprint).digest('hex').slice(0, 24)}`,
    workspaceId: `ws_${createHash('sha256').update(`${fingerprint}\u0000${repoRoot}`).digest('hex').slice(0, 24)}`,
    repoFingerprint: fingerprint,
    rootAlias: repoRoot,
    ...(remote ? { remote } : {}),
    ...(branch && !detached ? { branch } : {}),
    ...(headCommit ? { headCommit } : {}),
    dirty: status !== null && status.length > 0,
    shallow,
    detached,
  }
}