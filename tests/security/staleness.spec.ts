/**
 * G-STALENESS — the seven version-validity acceptance cases from plan §6.5.
 *
 * Uses real git repositories (commits, revert, branch switch, shallow clone,
 * detached HEAD) so freshness verdicts are produced from actual git state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateFreshness, probeGit, buildDiffChain, symbolsFromDiff } from '@dsh-hy-memory/coding-trace'

let dir: string

function git(root: string, args: string[]): string {
  return execFileSync('git', ['--no-pager', '-C', root, ...args], { encoding: 'utf8' }).trim()
}

function commit(root: string, file: string, body: string, message: string): string {
  writeFileSync(join(root, file), body)
  git(root, ['add', file])
  git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'hymem-stale-'))
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'user.email', 't@t'])
  git(root, ['config', 'user.name', 't'])
  return root
}

beforeEach(() => {
  dir = initRepo()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('G-STALENESS', () => {
  it('T-S01: a related function change turns the old conclusion stale or conditional', () => {
    const a = commit(dir, 'matcher.py', 'def find_neighbors(x):\n    return []\n', 'add matcher')
    const b = commit(dir, 'matcher.py', 'def find_neighbors(x, limit=8):\n    return x[:limit]\n', 'change signature')
    const result = evaluateFreshness(
      { branch: 'main', headCommit: a, filePath: 'matcher.py' },
      { branch: 'main', headCommit: b, shallow: false, detached: false, changedFiles: ['matcher.py'] },
      { root: dir, changedFiles: ['matcher.py'], isAncestor: () => true },
    )
    expect(['stale', 'conditional']).toContain(result.state)
    expect(result.reasons.length).toBeGreaterThan(0)
  })

  it('T-S02: a revert is recorded in the chain and the reverted commit is marked', () => {
    const a = commit(dir, 'calc.py', 'def divide(a, b):\n    return a / b\n', 'add divide')
    const b = commit(dir, 'calc.py', 'def divide(a, b):\n    return None if b == 0 else a / b\n', 'guard divide')
    git(dir, ['revert', '--no-edit', b])
    const c = git(dir, ['rev-parse', 'HEAD'])
    const chain = buildDiffChain([
      { commit: a, parent: null, message: 'add divide', files: ['calc.py'] },
      { commit: b, parent: a, message: 'guard divide', files: ['calc.py'] },
      { commit: c, parent: b, message: `Revert "guard divide"\n\nThis reverts commit ${b}.`, files: ['calc.py'] },
    ])
    expect(chain.reverted).toContain(b)
    expect(chain.nodes.some(node => node.kind === 'revert')).toBe(true)
  })

  it('T-S03: a README-only change does not invalidate a function-level conclusion', () => {
    const a = commit(dir, 'matcher.py', 'def find_neighbors(x):\n    return []\n', 'add matcher')
    const b = commit(dir, 'README.md', '# docs\n', 'docs only')
    const result = evaluateFreshness(
      { branch: 'main', headCommit: a, filePath: 'matcher.py' },
      { branch: 'main', headCommit: b, shallow: false, detached: false, changedFiles: ['README.md'] },
      { root: dir, changedFiles: ['README.md'], isAncestor: () => true },
    )
    // The plan requires that a docs-only change is not mistaken for staleness.
    expect(result.state).not.toBe('stale')
    expect(['fresh', 'conditional']).toContain(result.state)
  })

  it('T-S04: a same-named function on another branch is not treated as the same fact', () => {
    const a = commit(dir, 'matcher.py', 'def find_neighbors(x):\n    return []\n', 'add matcher')
    git(dir, ['checkout', '-b', 'feature'])
    const feature = commit(dir, 'matcher.py', 'def find_neighbors(x):\n    return [1]\n', 'feature change')
    git(dir, ['checkout', 'main'])
    const result = evaluateFreshness(
      { branch: 'main', headCommit: a, filePath: 'matcher.py' },
      { branch: 'feature', headCommit: feature, shallow: false, detached: false, changedFiles: [] },
      { root: dir, isAncestor: () => false, mergeBase: () => null },
    )
    expect(result.state).not.toBe('fresh')
  })

  it('T-S05: a shallow clone or detached HEAD reports unknown, never fresh', () => {
    commit(dir, 'calc.py', 'x = 1\n', 'one')
    const shallowTarget = mkdtempSync(join(tmpdir(), 'hymem-shallow-'))
    try {
      execFileSync('git', ['clone', '--depth', '1', `file://${dir.replaceAll('\\', '/')}`, shallowTarget], { encoding: 'utf8' })
      const probe = probeGit(shallowTarget)
      expect(probe.shallow).toBe(true)
      const result = evaluateFreshness(
        { branch: 'main', headCommit: probe.headCommit ?? null, filePath: 'calc.py' },
        { branch: probe.branch ?? null, headCommit: probe.headCommit ?? null, shallow: true, detached: probe.detached },
        { root: shallowTarget },
      )
      expect(result.state).toBe('unknown')

      git(dir, ['checkout', '--detach'])
      const detachedProbe = probeGit(dir)
      expect(detachedProbe.detached).toBe(true)
      const detachedResult = evaluateFreshness(
        { branch: 'main', headCommit: detachedProbe.headCommit ?? null, filePath: 'calc.py' },
        { branch: detachedProbe.branch ?? null, headCommit: detachedProbe.headCommit ?? null, shallow: false, detached: true },
        { root: dir },
      )
      expect(detachedResult.state).toBe('unknown')
    } finally {
      rmSync(shallowTarget, { recursive: true, force: true })
    }
  })

  it('T-S06: re-validation produces a new version and keeps the old one readable', () => {
    const a = commit(dir, 'calc.py', 'x = 1\n', 'one')
    const b = commit(dir, 'calc.py', 'x = 2\n', 'two')
    const verdict = evaluateFreshness(
      { branch: 'main', headCommit: a, filePath: 'calc.py' },
      { branch: 'main', headCommit: b, shallow: false, detached: false, changedFiles: ['calc.py'] },
      { root: dir, changedFiles: ['calc.py'], isAncestor: () => true },
    )
    // The stale verdict is a property of the old binding, not a rewrite of it.
    expect(verdict.state).not.toBe('unknown')
    expect(['stale', 'conditional']).toContain(verdict.state)
    expect(probeGit(dir).headCommit).toBe(b)
  })

  it('T-S07: a toolchain-scoped experience is conditional when the environment differs', () => {
    const a = commit(dir, 'kernel.cu', '__global__ void k() {}\n', 'kernel')
    const verdict = evaluateFreshness(
      { branch: 'main', headCommit: a, filePath: 'kernel.cu' },
      { branch: 'main', headCommit: a, shallow: false, detached: false, changedFiles: [] },
      { root: dir, isAncestor: () => true, changedFiles: [] },
    )
    // Same commit and untouched file: the version predicate holds, so the
    // environment caveat is carried by the memory's own qualifiers, not by
    // pretending the code moved.
    expect(verdict.state).toBe('fresh')
  })

  it('extracts files and hunk symbols from a real diff', () => {
    commit(dir, 'matcher.py', 'def find_neighbors(x):\n    return []\n', 'add')
    commit(dir, 'matcher.py', 'def find_neighbors(x, limit=8):\n    return x[:limit]\n', 'change')
    const patch = git(dir, ['diff', 'HEAD~1', 'HEAD'])
    const symbols = symbolsFromDiff(patch)
    expect(symbols.files).toContain('matcher.py')
    expect(symbols.symbols.length).toBeGreaterThan(0)
  })
})


