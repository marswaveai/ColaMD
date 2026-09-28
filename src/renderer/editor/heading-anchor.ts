import { parser } from '@lezer/markdown'

/** Find headings outside the viewport too, ignoring heading-like code blocks. */
export function headingAnchorLine(markdown: string, fragment: string): number | null {
  let target = fragment
  try { target = decodeURIComponent(fragment) } catch { /* use the literal fragment */ }
  const slugify = (text: string): string => text.trim().toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s+/g, '-')
  const seen = new Map<string, number>()
  let line: number | null = null
  parser.parse(markdown).iterate({
    enter(node) {
      if (!/^(ATX|Setext)Heading[1-6]$/.test(node.name)) return
      const title = markdown.slice(node.from, node.to)
        .replace(/^#{1,6}\s+|\s+#+\s*$|\r?\n[=-]+\s*$/g, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '')
      const base = slugify(title)
      const count = seen.get(base) ?? 0
      seen.set(base, count + 1)
      const slug = count ? `${base}-${count}` : base
      if (line === null && (slug === target.toLowerCase() || slug === slugify(target))) {
        line = markdown.slice(0, node.from).split('\n').length - 1
      }
      return false
    },
  })
  return line
}
