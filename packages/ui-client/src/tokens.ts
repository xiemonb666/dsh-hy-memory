/**
 * Token estimate for the injection-cost preview.
 *
 * Mirrors `estimateTokens` from `packages/contracts/src/index.ts` (ASCII runs at
 * one token per three characters, non-ASCII code points at one token each). The
 * calculation is copied — not imported — because the contracts module imports
 * `node:crypto` and must not enter the browser bundle.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let wide = 0
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) < 0x80) ascii++
    else wide++
  }
  return Math.ceil(ascii / 3) + wide
}

/** Total estimated tokens for a memory payload (content plus claim triples). */
export function estimateMemoryTokens(content: string, claimTexts: string[]): number {
  return estimateTokens(content) + estimateTokens(claimTexts.join('\n'))
}