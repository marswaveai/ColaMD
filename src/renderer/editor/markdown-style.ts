// The editor keeps a node tree, not text, so `-` and `*` are the same bullet
// once parsed and the original marker is gone. Saving therefore re-serialises the
// whole document in the serialiser's default style, which rewrites an imported
// file's punctuation even when the user changed one word.
//
// The practical fix is to make the serialiser follow the document: read the
// style this file already uses and emit the same markers. It cannot preserve
// mixed styles or exact blank-line placement, but it removes the surprise of a
// file whose bullet style flips the moment it is saved.
export interface MarkdownStyle {
  bullet?: '-' | '*' | '+'
  rule?: '-' | '*' | '_'
  emphasis?: '*' | '_'
  strong?: '*' | '_'
  fence?: '`' | '~'
}

const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/
const BULLET_LINE = /^\s{0,3}([-*+])\s+\S/
const RULE_LINE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/

export function detectMarkdownStyle(source: string): MarkdownStyle {
  const style: MarkdownStyle = {}
  const bullets: Partial<Record<'-' | '*' | '+', number>> = {}
  let rule: MarkdownStyle['rule']
  let fence: MarkdownStyle['fence']
  let emphasisStar = 0
  let emphasisUnderscore = 0
  let strongStar = 0
  let strongUnderscore = 0
  let inFence = false

  for (const line of source.split('\n')) {
    const fenceMatch = line.match(FENCE_LINE)
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as MarkdownStyle['fence']
      if (!inFence) fence ??= marker
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const bullet = line.match(BULLET_LINE)
    if (bullet) {
      const marker = bullet[1] as '-' | '*' | '+'
      bullets[marker] = (bullets[marker] ?? 0) + 1
    }

    const lineRule = line.match(RULE_LINE)
    if (lineRule) rule ??= lineRule[1] as MarkdownStyle['rule']

    strongStar += (line.match(/\*\*[^*\s][^*]*\*\*/g) ?? []).length
    strongUnderscore += (line.match(/__[^_\s][^_]*__/g) ?? []).length
    emphasisStar += (line.match(/(?:^|[^*])\*[^*\s][^*]*\*(?:[^*]|$)/g) ?? []).length
    emphasisUnderscore += (line.match(/(?:^|\W)_[^_\s][^_]*_(?:\W|$)/g) ?? []).length
  }

  const ranked = Object.entries(bullets).sort((a, b) => b[1] - a[1])
  if (ranked.length > 0) style.bullet = ranked[0][0] as MarkdownStyle['bullet']
  if (rule) style.rule = rule
  if (fence) style.fence = fence
  // Only switch away from the default when the file clearly prefers underscores.
  if (strongUnderscore > 0 && strongUnderscore > strongStar) style.strong = '_'
  if (emphasisUnderscore > 0 && emphasisUnderscore > emphasisStar) style.emphasis = '_'
  return style
}
