// 复制给 Markdown 去处的那一份原文（剪贴板的 text/plain）。
//
// 渲染模式里 `**`、`==`、`[`、`](url)`、`#`、`>`、代码围栏都藏着。选区两端落在看得见的字上，
// 换回原文的位置却可能停在这些标记里侧，直接截字节就只带半边标记：`高亮==`、`粗标题**`，
// 列表第一项掉出列表。
//
// 这里照 Typora 的模型：复制的是**选中的内容**，不是一段字节。
//   - 被选区切开的结构，补上它自己的标记：只选加粗的一半，得到 `**一半**`。
//   - 整段选区都在里面的块，不复制出来：只在引用里选，不带 `>`；只在代码块里选，没有围栏。
//   - 跨出去的块原样保留：从列表第一项拖到第三项，三项都还是列表。
// 完整选中的部分照原文一个字节不改，只在切口处补；用户自己的写法（`_` 还是 `*`）不动。

import { type EditorState, type SelectionRange } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { SyntaxNode, Tree } from '@lezer/common'
import { livePreviewField } from './live-preview'
import { frontmatterRange } from './math-scan'

/** 一段藏着定界符的行内格式：`[from, openEnd)` 是开标记，`[closeStart, to)` 是闭标记。 */
interface Span {
  from: number
  openEnd: number
  closeStart: number
  to: number
}

// 标记属于加粗节点本身的（`**`），装饰盖住整个节点；`==`、`[` 与 `](url)`、样式标签在装饰外面。
const INNER_MARKS = new Set(['cm-md-strong', 'cm-md-em', 'cm-md-strike', 'cm-md-inlinecode'])
const OUTER_MARKS = new Set(['cm-md-highlight', 'cm-md-link'])

/**
 * 从实际的装饰里认出行内格式：一段格式文字加上紧挨着它、确实被藏起来的两个定界符。
 * 以装饰为准而不是重新解析，藏了什么就补什么，和屏幕上看到的一致。
 */
function inlineSpans(state: EditorState, from: number, to: number): Span[] {
  const decorations = state.field(livePreviewField, false)
  if (!decorations) return []
  const marks: { from: number; to: number; inner: boolean }[] = []
  decorations.between(from, to, (a, b, decoration) => {
    if (a >= b || decoration.point) return
    const spec = decoration.spec as { class?: string; attributes?: { style?: string } }
    if (INNER_MARKS.has(spec.class ?? '')) marks.push({ from: a, to: b, inner: true })
    else if (OUTER_MARKS.has(spec.class ?? '') || (!spec.class && spec.attributes?.style)) marks.push({ from: a, to: b, inner: false })
  })
  if (marks.length === 0) return []
  const hidden: { from: number; to: number }[] = []
  const lo = Math.min(...marks.map((mark) => mark.from))
  const hi = Math.max(...marks.map((mark) => mark.to))
  decorations.between(lo, hi, (a, b, decoration) => {
    if (a < b && decoration.point && !decoration.spec.widget) hidden.push({ from: a, to: b })
  })
  const spans: Span[] = []
  for (const mark of marks) {
    if (mark.inner) {
      const open = hidden.find((h) => h.from === mark.from && h.to < mark.to)
      const close = open && hidden.find((h) => h.to === mark.to && h.from > open.to)
      if (close) spans.push({ from: mark.from, openEnd: open.to, closeStart: close.from, to: mark.to })
    } else {
      const open = hidden.find((h) => h.to === mark.from)
      const close = hidden.find((h) => h.from === mark.to)
      if (open && close) spans.push({ from: open.from, openEnd: mark.from, closeStart: mark.to, to: close.to })
    }
  }
  return spans
}

/**
 * 把落在定界符里的端点挪到格式外侧。开标记后面那一格与格式前面那一格看起来是同一处，
 * 闭标记前面也一样：停在开标记里算「从这段格式开头起」，停在闭标记里算「到这段格式结尾」。
 * 两端规则相同，所以只有一个函数。
 */
function settle(pos: number, spans: readonly Span[]): number {
  for (let round = 0; round <= spans.length; round++) {
    const span = spans.find((s) => (pos > s.from && pos <= s.openEnd) || (pos >= s.closeStart && pos < s.to))
    if (!span) break
    pos = pos <= span.openEnd ? span.from : span.to
  }
  return pos
}

// ─── 块 ──────────────────────────────────────────────────────────────────────

/** 每行都带前缀的块，以及它们行首的标记。 */
const PREFIXED_BLOCKS = /^(Blockquote|ListItem|Task|ATXHeading[1-6])$/
const LINE_MARKERS = new Set(['QuoteMark', 'ListMark', 'TaskMarker', 'HeaderMark'])

function isSpace(state: EditorState, pos: number): boolean {
  return /^[ \t]$/.test(state.sliceDoc(pos, pos + 1))
}

/** `pos` 处（允许先跳过三个空格）的行首标记。 */
function markerAt(state: EditorState, tree: Tree, pos: number, end: number): SyntaxNode | null {
  for (let n = 0; n <= 3 && pos < end; n++, pos++) {
    const node = tree.resolveInner(pos, 1)
    if (node.from === pos && LINE_MARKERS.has(node.name)) return node
    if (!isSpace(state, pos)) return null
  }
  return null
}

/** 标记连同它后面的空白。`>` 只带一个空格，再多的可能是引用里代码的缩进。 */
function afterMarker(state: EditorState, mark: SyntaxNode): number {
  let pos = mark.to
  const limit = mark.name === 'QuoteMark' ? 1 : 4
  for (let n = 0; n < limit && isSpace(state, pos); n++) pos++
  return pos
}

/**
 * 去掉 `blocks`（由外到内）在这一行上的前缀，返回剩下的起点。
 * 引用、任务、标题的前缀是标记；列表项的续行没有标记，前缀是对齐到正文的缩进。
 */
function bodyStart(state: EditorState, tree: Tree, from: number, blocks: readonly SyntaxNode[]): number {
  const line = state.doc.lineAt(from)
  let pos = line.from
  blocks.forEach((block, index) => {
    if (block.name === 'ListItem' && block.from > line.to) return
    if (block.name === 'ListItem' && block.from < line.from) {
      const mark = block.getChild('ListMark')
      if (!mark) return
      const width = afterMarker(state, mark) - bodyStart(state, tree, block.from, blocks.slice(0, index))
      for (let n = 0; n < width && pos < line.to && isSpace(state, pos); n++) pos++
      return
    }
    const mark = markerAt(state, tree, pos, line.to)
    if (!mark) return // 引用的懒续行没有 `>`
    const wanted = block.name === 'Blockquote' ? 'QuoteMark'
      : block.name === 'ListItem' ? 'ListMark'
      : block.name === 'Task' ? 'TaskMarker'
      : 'HeaderMark'
    if (mark.name === wanted) pos = afterMarker(state, mark)
  })
  return pos
}

/** 这一行正文的起点：`pos` 之后的行首标记与空白都跳过。 */
function contentStart(state: EditorState, tree: Tree, pos: number): number {
  const end = state.doc.lineAt(pos).to
  for (let mark = markerAt(state, tree, pos, end); mark; mark = markerAt(state, tree, pos, end)) pos = afterMarker(state, mark)
  while (pos < end && isSpace(state, pos)) pos++
  return pos
}

function ancestor(tree: Tree, pos: number, side: -1 | 1, name: RegExp): SyntaxNode | null {
  for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
    if (name.test(node.name)) return node
  }
  return null
}

/** 围栏代码块的开头那一行、收尾那一行（没闭合时为 null）与开头的围栏标记（``` 或 ~~~）。 */
function fenceParts(state: EditorState, fence: SyntaxNode) {
  const open = state.doc.lineAt(fence.from)
  const last = fence.lastChild
  const closeLine = last && last.name === 'CodeMark' && last.from > open.to ? state.doc.lineAt(last.from) : null
  const mark = fence.firstChild
  return { open, closeLine, mark: mark ? state.sliceDoc(mark.from, mark.to) : '```' }
}

/** 整段选区都在里面的块（由外到内），以及选区是不是整个在代码里。 */
function enclosingBlocks(tree: Tree, from: number, to: number): { enclosing: SyntaxNode[]; insideCode: boolean } {
  let common: SyntaxNode | null = tree.resolveInner(from, 1)
  while (common && !(common.from <= from && to <= common.to)) common = common.parent
  const enclosing: SyntaxNode[] = []
  let insideCode = false
  for (let node = common; node; node = node.parent) {
    if (PREFIXED_BLOCKS.test(node.name)) enclosing.unshift(node)
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') insideCode = true
  }
  return { enclosing, insideCode }
}

/**
 * 富文本口味用：整段选区都在里面的引用、列表项、标题。它们不该被带出来，
 * 列表项给出嵌套层级（与行上的 `cm-md-li-N` 对得上）。
 */
export function enclosingForHTML(state: EditorState, from: number, to: number): { quote: boolean; listDepths: number[]; heading: boolean } {
  const spans = inlineSpans(state, from, to)
  const tree = ensureSyntaxTree(state, state.doc.lineAt(to).to, 50) ?? syntaxTree(state)
  const { enclosing } = enclosingBlocks(tree, settle(from, spans), settle(to, spans))
  const listDepths = enclosing.filter((node) => node.name === 'ListItem').map((node) => {
    let depth = 0
    for (let parent = node.parent; parent; parent = parent.parent) if (parent.name === 'ListItem') depth++
    return depth
  })
  return {
    quote: enclosing.some((node) => node.name === 'Blockquote'),
    listDepths,
    heading: enclosing.some((node) => node.name.startsWith('ATXHeading')),
  }
}

/** 一段选区要交给 Markdown 去处的原文。 */
export function copiedMarkdown(state: EditorState, range: SelectionRange): string {
  const spans = inlineSpans(state, range.from, range.to)
  let from = settle(range.from, spans)
  let to = settle(range.to, spans)
  // 只选中了藏起来的标记：屏幕上什么也没选，照原样给
  if (from >= to) return state.sliceDoc(range.from, range.to)

  const tree = ensureSyntaxTree(state, state.doc.lineAt(to).to, 50) ?? syntaxTree(state)
  // 整段选区都在里面的块：它们的前缀不复制
  const { enclosing, insideCode } = enclosingBlocks(tree, from, to)
  const inFront = from < (frontmatterRange(state.doc.toString())?.to ?? 0)
  const lineBody = (pos: number) => bodyStart(state, tree, pos, enclosing)

  // 代码块被切开：补上缺的那一道围栏。容器前缀（引用的 `>`、列表的缩进）照开头那一行补。
  let fenceHead = ''
  let fenceTail = ''
  const startFence = insideCode ? null : ancestor(tree, from, 1, /^FencedCode$/)
  if (startFence && startFence.from < from) {
    const { open } = fenceParts(state, startFence)
    if (from <= open.to) from = startFence.from
    else {
      const lead = lineBody(open.from)
      fenceHead = state.sliceDoc(lead, open.to) + '\n'
      // 从代码行中间起选，这一行自己的前缀没在选区里，照开头那一行补上
      if (from > contentStart(state, tree, lineBody(from))) fenceHead += state.sliceDoc(lead, startFence.from)
      else from = lineBody(from)
    }
  }
  const endFence = insideCode ? null : ancestor(tree, to, -1, /^FencedCode$/)
  let toInCode = false
  if (endFence && endFence.from >= from && endFence.from < to && to < endFence.to) {
    const { open, closeLine, mark } = fenceParts(state, endFence)
    if (to <= open.to) to = open.from
    else if (closeLine && to >= closeLine.from) to = endFence.to
    else {
      toInCode = true
      const toLine = state.doc.lineAt(to)
      if (to > toLine.from && to <= contentStart(state, tree, lineBody(to))) to = toLine.from
      fenceTail = (to === state.doc.lineAt(to).from ? '' : '\n') + state.sliceDoc(lineBody(open.from), endFence.from) + mark
    }
  }

  const firstLine = state.doc.lineAt(from)
  let start = from
  let blockHead = ''
  if (!fenceHead) {
    const base = lineBody(from)
    start = Math.max(from, base)
    // 跨出的块保留类型；从文字中间起选时，只补前缀，不补没选中的文字。
    if (!insideCode && !inFront) {
      const content = contentStart(state, tree, base)
      if (from <= content) start = base
      else blockHead = state.sliceDoc(base, content)
    }
  }

  // 结束在下一行的行首标记里：那一行屏幕上一个字也没选，标记不带
  const lastLine = state.doc.lineAt(to)
  if (!insideCode && !toInCode && lastLine.number > firstLine.number && to > lastLine.from &&
      to <= contentStart(state, tree, lineBody(to))) to = lastLine.from

  // 要从原文里挖掉的：后续各行里属于外层块的前缀，以及没带开标记的标题末尾的 `###`
  const holes: [number, number][] = []
  if (enclosing.length > 0) {
    for (let n = firstLine.number + 1; n <= lastLine.number; n++) {
      const line = state.doc.line(n)
      const body = lineBody(line.from)
      if (body > line.from) holes.push([line.from, body])
    }
  }
  const heading = ancestor(tree, Math.min(start, firstLine.to), 1, /^ATXHeading[1-6]$/)
  const openMark = heading?.firstChild
  const closeMark = heading?.lastChild
  if (!blockHead && openMark && closeMark?.name === 'HeaderMark' && closeMark.from > openMark.to && start > openMark.from) {
    let holeFrom = closeMark.from
    while (holeFrom > start && isSpace(state, holeFrom - 1)) holeFrom--
    holes.unshift([holeFrom, closeMark.to])
  }
  holes.sort((a, b) => a[0] - b[0])

  let body = ''
  let pos = start
  for (const [a, b] of holes) {
    if (b <= pos || a >= to) continue
    body += state.sliceDoc(pos, Math.max(pos, a))
    pos = Math.max(pos, b)
  }
  body += state.sliceDoc(pos, Math.max(pos, to))

  // 选区两端切开的行内格式：开标记外层在前，闭标记内层在前
  const opening = spans.filter((span) => span.from < start && start < span.to).sort((a, b) => a.from - b.from || b.to - a.to)
  const closing = spans.filter((span) => span.from < to && to < span.to).sort((a, b) => a.to - b.to || b.from - a.from)
  return fenceHead + blockHead +
    opening.map((span) => state.sliceDoc(span.from, span.openEnd)).join('') +
    body +
    closing.map((span) => state.sliceDoc(span.closeStart, span.to)).join('') +
    fenceTail
}
