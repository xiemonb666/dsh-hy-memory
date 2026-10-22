import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildDiffChain,
  canonicalRemote,
  evaluateFreshness,
  fileContentHash,
  fingerprintWorkspace,
  isAncestor,
  probeGit,
  revertedCommitsInRange,
  symbolsFromDiff,
} from '@dsh-hy-memory/coding-trace'

const created: string[] = []

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

interface Fixture {
  root: string
  git: (...args: string[]) => string
  commits: string[]
}

function gitIn(root: string, ...args: string[]): string {
  return execFileSync('git', ['--no-pager', '-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
  }).trim()
}

function makeRepo(options: { withRevert?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'hymem-trace-'))
  created.push(dir)
  const root = join(dir, 'repo')
  mkdirSync(root)
  const git = (...args: string[]): string => gitIn(root, ...args)
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'HyMemory Test')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  const commits: string[] = []

  writeFileSync(join(root, 'README.md'), 'v1\n')
  writeFileSync(join(root, 'app.py'), 'def main():\n    return 1\n')
  git('add', '-A')
  git('commit', '-m', 'initial commit')
  commits.push(git('rev-parse', 'HEAD'))

  writeFileSync(join(root, 'README.md'), 'v2\n')
  git('add', '-A')
  git('commit', '-m', 'update readme')
  commits.push(git('rev-parse', 'HEAD'))

  writeFileSync(join(root, 'app.py'), 'def main():\n    return 2\n')
  git('add', '-A')
  git('commit', '-m', 'change app behaviour')
  commits.push(git('rev-parse', 'HEAD'))

  if (options.withRevert !== false) {
    git('revert', '--no-edit', commits[2]!)
    commits.push(git('rev-parse', 'HEAD'))
  }
  return { root, git, commits }
}

describe('workspace fingerprint', () => {
  it('creates a persisted workspace id when there is no remote and stays stable', () => {
    const { root, commits } = makeRepo()
    const first = fingerprintWorkspace(root)
    const idFile = join(root, '.git', 'dsh-hy-memory-workspace-id')
    expect(existsSync(idFile)).toBe(true)
    expect(readFileSync(idFile, 'utf8').trim().length).toBeGreaterThan(0)
    expect(first.repoFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(first.branch).toBe('main')
    expect(first.headCommit).toBe(commits[3])
    expect(first.shallow).toBe(false)
    expect(first.detached).toBe(false)
    expect(first.dirty).toBe(false)
    expect(first.rootAlias.startsWith('repo#')).toBe(true)

    // A new commit must not change the workspace identity.
    writeFileSync(join(root, 'extra.txt'), 'x\n')
    gitIn(root, 'add', '-A')
    gitIn(root, 'commit', '-m', 'extra')
    const second = fingerprintWorkspace(root)
    expect(second.repoFingerprint).toBe(first.repoFingerprint)
    expect(second.headCommit).not.toBe(first.headCommit)
  })

  it('derives the fingerprint from the canonical remote when origin exists', () => {
    const { root } = makeRepo()
    gitIn(root, 'remote', 'add', 'origin', 'https://GitHub.com/Example/Repo.git')
    const fingerprint = fingerprintWorkspace(root)
    expect(fingerprint.remote).toBe('https://github.com/Example/Repo')
    expect(fingerprint.repoFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(join(root, '.git', 'dsh-hy-memory-workspace-id'))).toBe(false)

    gitIn(root, 'remote', 'set-url', 'origin', 'https://github.com/Example/Repo/')
    expect(fingerprintWorkspace(root).repoFingerprint).toBe(fingerprint.repoFingerprint)
  })

  it('normalizes equivalent remote URLs to one canonical form', () => {
    expect(canonicalRemote('https://GitHub.com/Example/Repo.git')).toBe('https://github.com/Example/Repo')
    expect(canonicalRemote('https://user:secret@github.com/Example/Repo.git/')).toBe('https://github.com/Example/Repo')
    expect(canonicalRemote('https://github.com:443/Example/Repo')).toBe('https://github.com/Example/Repo')
    expect(canonicalRemote('git@github.com:Example/Repo.git')).toBe('ssh://git@github.com/Example/Repo')
    expect(canonicalRemote('ssh://git@github.com:22/Example/Repo.git')).toBe('ssh://git@github.com/Example/Repo')
    expect(canonicalRemote('')).toBe('')
  })
})

describe('probeGit', () => {
  it('reports branch, head, merge-base, clean state and remote', () => {
    const { root, commits } = makeRepo()
    const probe = probeGit(root, { baseCommit: commits[0] })
    expect(probe.branch).toBe('main')
    expect(probe.headCommit).toBe(commits[3])
    expect(probe.baseCommit).toBe(commits[0])
    expect(probe.dirty).toBe(false)
    expect(probe.changedFiles).toEqual([])
    expect(probe.shallow).toBe(false)
    expect(probe.detached).toBe(false)
    expect(probe.remote).toBeNull()
  })

  it('reports dirty state and changed files, including an untracked file', () => {
    const { root } = makeRepo()
    writeFileSync(join(root, 'README.md'), 'v3\n')
    writeFileSync(join(root, 'new-file.ts'), 'export const x = 1\n')
    const probe = probeGit(root)
    expect(probe.dirty).toBe(true)
    expect(probe.changedFiles).toEqual(expect.arrayContaining(['README.md', 'new-file.ts']))
  })

  it('detects detached HEAD', () => {
    const { root, commits } = makeRepo()
    gitIn(root, 'checkout', '--detach', commits[1]!)
    const probe = probeGit(root)
    expect(probe.detached).toBe(true)
    expect(probe.branch).toBeNull()
    expect(probe.headCommit).toBe(commits[1])
  })

  it('detects a shallow clone', () => {
    const { root } = makeRepo()
    const cloneParent = mkdtempSync(join(tmpdir(), 'hymem-clone-'))
    created.push(cloneParent)
    const clone = join(cloneParent, 'shallow')
    execFileSync('git', ['clone', '--depth', '1', pathToFileURL(root).href, clone], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 30_000 })
    const probe = probeGit(clone)
    expect(probe.shallow).toBe(true)
    expect(probe.headCommit).not.toBeNull()
  })

  it('answers isAncestor in both directions', () => {
    const { root, commits } = makeRepo()
    expect(isAncestor(commits[0]!, commits[3]!, { root })).toBe(true)
    expect(isAncestor(commits[3]!, commits[0]!, { root })).toBe(false)
  })

  it('rejects unsafe git refs instead of passing them to git', () => {
    const { root, commits } = makeRepo()
    expect(() => probeGit(root, { baseCommit: '--upload-pack=evil' })).toThrow(/unsafe git ref/)
    expect(() => isAncestor(commits[0]!, '--output=/tmp/x', { root })).toThrow(/unsafe git ref/)
  })
})

describe('freshness evaluation', () => {
  it('is fresh when the bound commit is an ancestor and bound files are unchanged', () => {
    const { root, commits } = makeRepo()
    const current = probeGit(root)
    const binding = {
      headCommit: commits[0]!,
      baseCommit: commits[0]!,
      branch: 'main',
      files: [{ path: 'app.py', hash: fileContentHash(join(root, 'app.py')) }],
    }
    // app.py at HEAD is the reverted (== initial) content, so the hash matches.
    const result = evaluateFreshness(binding, current, { root, changedFiles: [] })
    expect(result.state).toBe('fresh')
    expect(result.reasons).toContain('bound_files_unchanged')
  })

  it('is stale when a bound file hash changed', () => {
    const { root, commits } = makeRepo()
    const current = probeGit(root)
    const binding = {
      headCommit: commits[0]!,
      branch: 'main',
      files: [{ path: 'README.md', hash: '0'.repeat(64) }],
    }
    const result = evaluateFreshness(binding, current, { root })
    expect(result.state).toBe('stale')
    expect(result.reasons).toContain('bound_file_changed:README.md')
  })

  it('is stale when the bound commit was reverted in the range', () => {
    const { root, commits } = makeRepo()
    const current = probeGit(root)
    expect(revertedCommitsInRange(root, commits[2]!, commits[3]!)).toEqual([commits[2]!])
    const binding = {
      headCommit: commits[2]!,
      branch: 'main',
      files: [{ path: 'app.py', hash: fileContentHash(join(root, 'app.py')) }],
    }
    const result = evaluateFreshness(binding, current, { root })
    expect(result.state).toBe('stale')
    expect(result.reasons).toContain('bound_commit_reverted')
  })

  it('is stale when the bound commit is not an ancestor after a branch switch', () => {
    const { root, commits } = makeRepo()
    gitIn(root, 'checkout', '-b', 'feature', commits[0]!)
    writeFileSync(join(root, 'feature.py'), 'def feature():\n    return 3\n')
    gitIn(root, 'add', '-A')
    gitIn(root, 'commit', '-m', 'feature work')
    const current = probeGit(root)
    const binding = { headCommit: commits[1]!, branch: 'main', files: [] }
    const result = evaluateFreshness(binding, current, { root })
    expect(current.branch).toBe('feature')
    expect(result.state).toBe('stale')
    expect(result.reasons).toContain('bound_commit_not_ancestor')
    expect(result.reasons).toContain('branch_changed')
  })

  it('is conditional when only unrelated files changed', () => {
    const { root, commits } = makeRepo()
    const current = probeGit(root)
    const binding = {
      headCommit: commits[0]!,
      branch: 'main',
      files: [{ path: 'app.py', hash: fileContentHash(join(root, 'app.py')) }],
    }
    const result = evaluateFreshness(binding, current, { root, changedFiles: ['README.md'] })
    expect(result.state).toBe('conditional')
    expect(result.reasons).toContain('unrelated_files_changed')
  })

  it('is unknown for a shallow clone and for detached HEAD', () => {
    const { root, commits } = makeRepo()
    const cloneParent = mkdtempSync(join(tmpdir(), 'hymem-clone-'))
    created.push(cloneParent)
    const clone = join(cloneParent, 'shallow')
    execFileSync('git', ['clone', '--depth', '1', pathToFileURL(root).href, clone], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 30_000 })
    const shallowCurrent = probeGit(clone)
    const shallowResult = evaluateFreshness(
      { headCommit: commits[0]!, branch: 'main', files: [] },
      shallowCurrent,
      { root: clone },
    )
    expect(shallowResult.state).toBe('unknown')
    expect(shallowResult.reasons).toContain('shallow_repository')

    gitIn(root, 'checkout', '--detach', commits[1]!)
    const detachedCurrent = probeGit(root)
    const detachedResult = evaluateFreshness({ headCommit: commits[0]!, branch: 'main', files: [] }, detachedCurrent, { root })
    expect(detachedResult.state).toBe('unknown')
    expect(detachedResult.reasons).toContain('detached_head')
  })

  it('is unknown when the current head is missing', () => {
    const result = evaluateFreshness({ headCommit: 'abc1234', branch: 'main' }, { branch: 'main' }, {})
    expect(result.state).toBe('unknown')
    expect(result.reasons).toContain('missing_current_head')
  })
})

describe('diff chain and symbols', () => {
  it('orders events by parent and marks reverted nodes', () => {
    const c1 = '1111111111111111111111111111111111111111'
    const c2 = '2222222222222222222222222222222222222222'
    const c3 = '3333333333333333333333333333333333333333'
    const patch = [
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,2 +1,3 @@ export function load(',
      ' export function load(',
      '+  return 1',
    ].join('\n')
    const chain = buildDiffChain([
      { commit: c3, parent: c2, message: `Revert "change b"\n\nThis reverts commit ${c2}.` },
      { commit: c1, parent: null, message: 'initial', files: ['a.ts'] },
      { commit: c2, parent: c1, message: 'change b', patch, tests: ['tests/b.spec.ts'] },
    ])

    expect(chain.nodes.map(node => node.commit)).toEqual([c1, c2, c3])
    expect(chain.nodes.map(node => node.kind)).toEqual(['change', 'change', 'revert'])
    expect(chain.reverted).toEqual([c2])
    expect(chain.baseCommit).toBe(c1)
    expect(chain.headCommit).toBe(c3)
    expect(chain.nodes[1]!.patchHash).toMatch(/^[0-9a-f]{64}$/)
    expect(chain.nodes[1]!.files).toEqual(['src/b.ts'])
    expect(chain.nodes[1]!.tests).toEqual(['tests/b.spec.ts'])
  })

  it('extracts files, hunk headers and best-effort declarations from a patch', () => {
    const patch = [
      'diff --git a/src/app.py b/src/app.py',
      'index 1111111..2222222 100644',
      '--- a/src/app.py',
      '+++ b/src/app.py',
      '@@ -1,4 +1,5 @@ def main():',
      ' def main():',
      '-    return 1',
      '+    return 2',
      '+def helper(x):',
      'diff --git a/src/util.ts b/src/util.ts',
      '--- a/src/util.ts',
      '+++ b/src/util.ts',
      '@@ -10,2 +10,3 @@ export function run(',
      ' export function run(',
      '+  const value = 1',
    ].join('\n')

    const result = symbolsFromDiff(patch)
    expect(result.files).toEqual(['src/app.py', 'src/util.ts'])
    expect(result.symbols).toEqual(
      expect.arrayContaining([
        { file: 'src/app.py', symbol: 'def main():', kind: 'hunk' },
        { file: 'src/app.py', symbol: 'main', kind: 'declaration' },
        { file: 'src/app.py', symbol: 'helper', kind: 'declaration' },
        { file: 'src/util.ts', symbol: 'export function run(', kind: 'hunk' },
        { file: 'src/util.ts', symbol: 'run', kind: 'declaration' },
      ]),
    )
  })
})
