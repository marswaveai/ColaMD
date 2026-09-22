// YAML frontmatter is metadata, not document text, and it has to survive a trip
// through the editor byte for byte. Obsidian keeps a note's properties in a
// block between two `---` lines at the very top of the file, and a rich text
// parser reads that block as ordinary Markdown: `tags:` followed by an indented
// list comes back as a stray nested list item, which is no longer valid YAML and
// quietly breaks the properties panel, tag search and Dataview in the vault it
// came from (issue #109, reported against 2.4.3 with a minimal sample). So the
// block never enters the editor: the document is split on load, the block is
// carried next to the document, and it is written back verbatim.
//
// The test below is deliberately generous, because the two ways of being wrong
// are not equally expensive. A block we fail to recognize is a block we rewrite,
// which is the bug this file exists to prevent. A block we recognize wrongly is
// only kept out of the editor, and still lands in the file unchanged.

export interface SplitDocument {
  /** The verbatim block, delimiters and following blank lines included. */
  frontmatter: string
  /** Everything the editor should see. */
  body: string
}

// The opening line is exactly `---`; trailing spaces are allowed, trailing text
// is not, and Windows editors may leave a BOM in front of it.
const OPENS = /^(?:\uFEFF)?---[ \t]*$/
// YAML closes a document with `---` or, less often, with `...`.
const CLOSES = /^(?:---|\.\.\.)[ \t]*$/
const BLANK = /^[ \t]*$/
// A YAML comment line. It carries no property on its own, but it proves the
// block is metadata rather than prose, so finding one is enough to keep the
// block out of the editor. A `#` line inside the block is never a Markdown
// heading: headings cannot live inside a leading `---` properties block.
const COMMENT = /^[ \t]*#[^\n]*$/
// A `key: value` line. YAML keys are Unicode scalars, not ASCII words, so an
// Obsidian note can use non-ASCII property names. Quoted keys (`"..."` /
// `'...'`) are legal YAML as well. The value side is intentionally loose: an
// empty value, a block scalar (`|` / `>`), or a flow value all count, because
// recognition only decides whether the block stays out of the editor, never
// whether the YAML itself is valid.
const MAPPING_ENTRY =
  /^[ \t]*(?:[\p{L}\p{N}_][\p{L}\p{N}_.-]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')[ \t]*:([ \t]|$)/u
// A note's properties are a short header. Past this many lines the opening `---`
// is a horizontal rule and the document simply starts with one.
const MAX_LINES = 100

function whole(body: string): SplitDocument {
  return { frontmatter: '', body }
}

export function splitFrontmatter(markdown: string): SplitDocument {
  if (!/^(?:\uFEFF)?---/.test(markdown)) return whole(markdown)

  // Split only for inspection: every slice that ends up in the result is taken
  // from the original string, so `\r\n` and any other byte survive untouched.
  const lines = markdown.split('\n')
  if (!OPENS.test(lines[0].replace(/\r$/, ''))) return whole(markdown)

  let hasEntry = false
  const limit = Math.min(lines.length, MAX_LINES + 1)
  for (let i = 1; i < limit; i++) {
    const text = lines[i].replace(/\r$/, '')
    if (CLOSES.test(text)) {
      // `---` with nothing that looks like a property is a horizontal rule.
      if (!hasEntry) return whole(markdown)
      // The blank lines after the block stay with it: they separate the metadata
      // from the text, the editor would drop them from the body, and losing them
      // on a save nobody asked for is the same class of surprise as rewriting the
      // block itself.
      let last = i
      while (last + 1 < lines.length && BLANK.test(lines[last + 1].replace(/\r$/, ''))) last++
      const endsWithNewline = last < lines.length - 1
      return {
        frontmatter: lines.slice(0, last + 1).join('\n') + (endsWithNewline ? '\n' : ''),
        body: endsWithNewline ? lines.slice(last + 1).join('\n') : ''
      }
    }
    // A `#` line inside the block is a YAML comment, not prose: it keeps the
    // block out of the editor but never counts as a property on its own.
    // (A Markdown heading cannot live inside a leading `---` properties
    // block, so the old early return treated comments as titles and handed
    // the whole block to the editor, where it was rewritten.)
    if (COMMENT.test(text)) continue
    if (MAPPING_ENTRY.test(text)) hasEntry = true
  }

  return whole(markdown)
}
