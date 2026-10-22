/**
 * Minimal unified-diff parser for the Evidence page diff viewer.
 *
 * Supports `@@ -a,b +c,d @@` hunk headers and tracks old/new line numbers so the
 * viewer can render real gutters. Anything the parser does not understand is
 * kept as a context line rather than dropped, so a patch is never silently
 * shortened.
 */
export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface DiffHunk {
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/

/** Split a unified diff body into hunks with line-numbered lines. */
export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (const raw of patch.split(/\r?\n/)) {
    const match = HUNK_RE.exec(raw)
    if (match) {
      oldLine = Number(match[1] ?? 0)
      newLine = Number(match[3] ?? 0)
      current = {
        header: raw.trim(),
        oldStart: oldLine,
        newStart: newLine,
        lines: [],
      }
      hunks.push(current)
      continue
    }

    if (!current) {
      if (raw.trim() === '' || raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('---') || raw.startsWith('+++')) {
        continue
      }
      current = { header: '', oldStart: 0, newStart: 0, lines: [] }
      hunks.push(current)
      oldLine = 0
      newLine = 0
    }

    if (raw.startsWith('\\')) continue

    if (raw.startsWith('+')) {
      current.lines.push({ kind: 'add', text: raw.slice(1), oldLine: null, newLine })
      newLine++
    } else if (raw.startsWith('-')) {
      current.lines.push({ kind: 'del', text: raw.slice(1), oldLine, newLine: null })
      oldLine++
    } else {
      current.lines.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw, oldLine, newLine })
      oldLine++
      newLine++
    }
  }

  return hunks
}

export function countLines(hunks: DiffHunk[]): number {
  return hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
}