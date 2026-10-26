// 段落分隔只参与排版，不改源码。真正的空段落仍有正常行高。
// 跨行替换必须由 StateField 提供；光标同时把这些区间当作原子，避免盲打。
import { EditorSelection, EditorState, Prec, StateField, Transaction, type ChangeDesc, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode, Tree } from '@lezer/common'
import { excludedRanges, frontmatterRange, scanMath, type Excluded } from './math-scan'

interface Block {
  from: number
  to: number
  contentFrom: number
  heading: number
  prose: boolean
}
interface Gap { from: number; to: number; right: number }
interface Layout {
  decorations: DecorationSet
  atomic: DecorationSet
  gaps: Gap[]
  blocks: Block[]
  protected: { from: number; to: number }[]
  cursorRanges: { from: number; to: number }[]
}

class Separator extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-md-paragraph-separator'
    span.setAttribute('aria-hidden', 'true')
    return span
  }
}
const separatorWidget = new Separator()

// 复杂块有自己的内边距和 widget，不能用通用行 padding 覆盖。
class BlockSpace extends WidgetType {
  constructor(readonly heading: number) { super() }
  eq(other: BlockSpace): boolean { return other.heading === this.heading }
  toDOM(): HTMLElement {
    const space = document.createElement('div')
    space.className = 'cm-md-block-space' + (this.heading ? ` cm-md-after-heading${this.heading}` : '')
    space.setAttribute('aria-hidden', 'true')
    return space
  }
}

interface Protection {
  text: string
  hasMath: boolean
  front: Excluded | null
  math: ReturnType<typeof scanMath>
  tree: Tree
  doc: EditorState['doc']
}
const codeRanges = new WeakMap<Tree, Excluded[]>()

// 只在块边界未变、无公式的块内部替换字母数字时映射，避免改变定界符与代码排除区。
function canMapProtection(state: EditorState, nodes: SyntaxNode[], previous: IncrementalLayout,
  changes: ChangeDesc, front: Excluded | null): boolean {
  const old = previous.protection, parts = previous.parts.slice(0, -1)
  if (changes.empty || nodes.length !== parts.length || !!old.front !== !!front
    || front && front.to !== changes.mapPos(old.front!.to, 1)) return false
  if (!nodes.every((node, index) => {
    const part = parts[index]
    return node.name === part.name && node.from === changes.mapPos(part.from, -1)
      && node.to === changes.mapPos(part.to, 1)
  })) return false
  let safe = true
  changes.iterChangedRanges((from, to, next, end) => {
    const part = parts.find(part => !part.skipped && from > part.from && to < part.to)
    if (!part || /[$\\]/.test(old.doc.sliceString(part.from, part.to))
      || !/^[\p{L}\p{N}]*$/u.test(old.doc.sliceString(from, to) + state.doc.sliceString(next, end))) safe = false
  })
  return safe
}

function protection(state: EditorState, nodes?: SyntaxNode[], previous?: IncrementalLayout, changes?: ChangeDesc): Protection {
  const doc = state.doc, tree = syntaxTree(state), old = previous?.protection
  if (old?.doc === doc && old.tree === tree) return old
  let text: string | undefined
  const source = (): string => text ??= doc.toString()
  const front = doc.sliceString(0, 3) !== '---' ? null
    : old?.front && changes && !changes.touchesRange(0, old.front.to)
      ? { from: 0, to: changes.mapPos(old.front.to, 1) } : frontmatterRange(source())
  const finish = (math: ReturnType<typeof scanMath>, hasMath: boolean): Protection => ({
    get text() { return source() }, front, math, hasMath, tree, doc,
  })
  if (old && !old.hasMath && changes) {
    let insertedMath = false
    changes.iterChangedRanges((_from, _to, from, to) => { insertedMath ||= /[$\\]/.test(doc.sliceString(from, to)) })
    if (!insertedMath) return finish([], false)
  }
  if (old && changes && nodes && previous && canMapProtection(state, nodes, previous, changes, front)) {
    return finish(old.math.map(range => ({ ...range,
      from: changes.mapPos(range.from, -1), to: changes.mapPos(range.to, 1),
    })), old.hasMath)
  }
  const hasMath = /[$\\]/.test(source())
  if (!hasMath) return finish([], false)
  const excluded = nodes ? [...(front ? [front] : []), ...nodes.flatMap(node => {
    const tree = node.tree ?? node.toTree()
    let ranges = codeRanges.get(tree)
    if (!ranges) { ranges = excludedRanges('', tree); codeRanges.set(tree, ranges) }
    return ranges.map(range => ({ from: node.from + range.from, to: node.from + range.to }))
  })] : excludedRanges(source(), tree)
  return finish(scanMath(source(), excluded).filter(range => range.block), true)
}

function hasBlockWrapper(state: EditorState, pos: number): boolean {
  return state.facet(EditorView.blockWrappers).some(ranges => {
    if (typeof ranges === 'function') return false
    for (let cursor = ranges.iter(pos); cursor.value && cursor.from <= pos; cursor.next()) {
      if (cursor.to > pos) return true
    }
    return false
  })
}

interface LayoutOptions {
  nodes?: SyntaxNode[]
  previous?: Block | null
  tail?: boolean
  protection?: Protection
  empty?: boolean
}

function buildLayout(state: EditorState, options: LayoutOptions = {}): Layout {
  const { nodes, tail = true, protection: protectedRanges = protection(state), empty = true } = options
  let previous = options.previous ?? null
  const { front, math } = protectedRanges
  const decorations: { from: number; to: number; value: Decoration }[] = []
  const gaps: Gap[] = []
  const separator = (fromLine: number, toLine: number): void => {
    // 每组换行保留最后一个来断行。空段落落在两组之间，输入后左右各有完整分隔。
    // 不能把所有隐藏字符集中放前面，否则在空段打字会得到三行换行 + 一行换行。
    let line = fromLine
    while (line < toLine) {
      const remaining = toLine - line
      const width = remaining === 1 ? 1 : remaining % 2 === 1 && line === fromLine ? 3 : 2
      const from = state.doc.line(line).to
      const to = state.doc.line(line + width - 1).to
      if (to > from) {
        gaps.push({ from, to, right: to + 1 })
        decorations.push({ from, to, value: Decoration.replace({ widget: separatorWidget }) })
      }
      line += width
    }
  }
  const blocks: Block[] = []
  const children = nodes ?? topBlocks(state)
  for (const node of children) {
    // 属性区不参与正文排版；块公式可能横跨多个 Paragraph 节点，不能拆它内部的空行。
    if ((front && node.from < front.to) || math.some(range => node.from < range.to && node.to > range.from)
      || node.name === 'LinkReference') {
      previous = null
      continue
    }
    const block = layoutBlock(state, node)
    const first = state.doc.lineAt(block.from)
    blocks.push(block)
    if (!previous && !front && /^[ \t\n]*$/.test(state.doc.sliceString(0, block.from))) {
      separator(1, first.number)
    }
    let connected = false
    let emptyParagraph = false
    if (previous) {
      const between = state.doc.sliceString(previous.to, block.from)
      if (/^\n(?:[ \t]*\n)*$/.test(between)) {
        connected = true
        // 0/1/2 个空行只作分隔，三个起保留可输入空段。
        const blankCount = first.number - state.doc.lineAt(previous.to).number - 1
        emptyParagraph = blankCount >= 3
        separator(state.doc.lineAt(previous.to).number, first.number)
      }
    }
    if (block.prose) {
      const classes = [
        !block.heading && connected ? 'cm-md-flow-paragraph' : '',
        connected && !emptyParagraph && previous?.heading ? `cm-md-after-heading${previous.heading}` : '',
      ].filter(Boolean).join(' ')
      if (classes) decorations.push({ from: block.from, to: block.from, value: Decoration.line({ class: classes }) })
    } else if (connected) {
      // 未包装的表格共用行盒以保留实测表高；行包装里的留白不能挤进表头。
      decorations.push({
        from: block.from, to: block.from,
        value: Decoration.widget({ widget: new BlockSpace(emptyParagraph ? 0 : previous!.heading), block: node.name !== 'Table' || hasBlockWrapper(state, node.from), side: -1 }),
      })
    }
    previous = block
  }
  // 文末保留可输入的空段落。一次 Enter 插入两个换行，屏幕上只新增一段。
  if (tail && previous) {
    const tail = state.doc.sliceString(previous.to)
    if (/^\n{2,}$/.test(tail)) {
      separator(state.doc.lineAt(previous.to).number, state.doc.lines)
    }
  } else if (tail && empty && blocks.length === 0 && /^\n+$/.test(protectedRanges.text)) {
    separator(1, state.doc.lines)
  }
  // 标题的隐藏 # 与前面的分隔组成同一段导航区间，右移后打字直接落在标题文字。
  const cursorRanges: { from: number; to: number }[] = []
  const hidden = [
    ...gaps.map(gap => ({ from: gap.from, to: gap.right, heading: false })),
    ...blocks.filter(block => block.contentFrom > block.from).map(block => ({ from: block.from, to: block.contentFrom, heading: true })),
  ].sort((a, b) => a.from - b.from)
  for (const range of hidden) {
    const last = cursorRanges.at(-1)
    if (last && (range.from < last.to || range.from === last.to && range.heading)) last.to = Math.max(last.to, range.to)
    else cursorRanges.push({ from: range.from, to: range.to })
  }
  return {
    decorations: Decoration.set(decorations.map(item => item.value.range(item.from, item.to)), true),
    atomic: Decoration.set(cursorRanges.map(range => Decoration.replace({}).range(range.from, range.to)), true),
    gaps, blocks, protected: nodes ? [] : [...(front ? [front] : []), ...math], cursorRanges,
  }
}

function layoutBlock(state: EditorState, node: SyntaxNode): Block {
  const first = state.doc.lineAt(node.from)
  const heading = /^ATXHeading([1-6])$/.exec(node.name)
  const marker = heading ? /^ {0,3}#{1,6}[ \t]+/.exec(first.text) : null
  return {
    from: first.from,
    // HTMLBlock 的 to 可以恰好是下一行行首，不能把那一行分隔空行算进块里。
    to: state.doc.lineAt(Math.max(node.from, node.to - 1)).to,
    contentFrom: first.from + (marker?.[0].length ?? 0),
    heading: heading ? Number(heading[1]) : 0,
    prose: node.name === 'Paragraph' || !!heading,
  }
}

function topBlocks(state: EditorState): SyntaxNode[] {
  const nodes: SyntaxNode[] = []
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) nodes.push(node)
  return nodes
}

interface LayoutPart {
  from: number
  to: number
  name: string
  previous: Block | null
  skipped: boolean
  wrapped: boolean
  leading: boolean
  layout: Layout
}
interface IncrementalLayout extends Layout {
  parts: LayoutPart[]
  protection: Protection
}

function mapLayout(layout: Layout, changes: ChangeDesc): Layout {
  const range = <T extends { from: number; to: number }>(item: T): T => ({
    ...item, from: changes.mapPos(item.from, -1), to: changes.mapPos(item.to, 1),
  })
  return {
    decorations: layout.decorations.map(changes), atomic: layout.atomic.map(changes),
    gaps: layout.gaps.map(item => ({ ...range(item), right: changes.mapPos(item.right, 1) })),
    blocks: layout.blocks.map(item => ({ ...range(item), contentFrom: changes.mapPos(item.contentFrom, -1) })),
    protected: layout.protected.map(range), cursorRanges: layout.cursorRanges.map(range),
  }
}

function sameBlock(a: Block | null, b: Block | null): boolean {
  return a === b || !!(a && b && a.from === b.from && a.to === b.to && a.contentFrom === b.contentFrom
    && a.heading === b.heading && a.prose === b.prose)
}

function updateLayout(state: EditorState, value?: IncrementalLayout, changes?: ChangeDesc): IncrementalLayout {
  const nodes = topBlocks(state)
  const protectedRanges = protection(state, nodes, value, changes)
  const { front, math } = protectedRanges
  const mappedParts = value?.parts.map((part, index) => {
    const mapped = changes && !changes.empty ? {
      ...part, from: changes.mapPos(part.from, -1), to: changes.mapPos(part.to, 1),
      previous: part.previous ? { ...part.previous, from: changes.mapPos(part.previous.from, -1),
        to: changes.mapPos(part.previous.to, 1), contentFrom: changes.mapPos(part.previous.contentFrom, -1) } : null,
      layout: mapLayout(part.layout, changes),
    } : part
    return { part: mapped, original: part.layout,
      touched: changes?.touchesRange(part.previous?.to ?? (index === 0 ? 0 : part.from),
        part.layout.blocks[0]?.contentFrom ?? part.to) }
  }) ?? []
  const old = new Map(mappedParts.map(item => [`${item.part.from}:${item.part.to}:${item.part.name}`, item]))
  const parts: LayoutPart[] = []
  const retained = new Set<Layout>()
  const rebuilt: Layout[] = []
  let previous: Block | null = null
  let hasBlocks = false
  const add = (from: number, to: number, name: string, nodes: SyntaxNode[], skipped: boolean): void => {
    const found = old.get(`${from}:${to}:${name}`)
    const part = found?.part
    const wrapped = name === 'Table' && hasBlockWrapper(state, from)
    const layout = part && !found.touched && part.skipped === skipped && part.wrapped === wrapped && part.leading === (parts.length === 0) && sameBlock(part.previous, previous)
      && sameBlock(part.layout.blocks[0] ?? null, nodes.length && !skipped ? layoutBlock(state, nodes[0]) : null)
      && !!value?.protection.front === !!front
      ? part.layout : buildLayout(state, { nodes, previous, tail: name === '', protection: protectedRanges, empty: !hasBlocks })
    if (layout === part?.layout) retained.add(layout)
    else rebuilt.push(layout)
    parts.push({ from, to, name, previous, skipped, wrapped, leading: parts.length === 0, layout })
    hasBlocks ||= layout.blocks.length > 0
    previous = layout.blocks.at(-1) ?? (skipped ? null : previous)
  }
  // 只比较顶层块边界；行内语法变化不影响段距，后台解析新增的块照常进入这里。
  for (const node of nodes) {
    const skipped = !!(front && node.from < front.to) || math.some(range => node.from < range.to && node.to > range.from)
      || node.name === 'LinkReference'
    add(node.from, node.to, node.name, [node], skipped)
  }
  add(state.doc.length, state.doc.length, '', [], false)
  const layouts = parts.map(part => part.layout)
  const removed = mappedParts.filter(item => !retained.has(item.part.layout)).map(item => item.original)
  const update = (key: 'decorations' | 'atomic'): DecorationSet => {
    const add: Range<Decoration>[] = []
    for (const layout of rebuilt) {
      for (let cursor = layout[key].iter(); cursor.value; cursor.next()) add.push(cursor.value.range(cursor.from, cursor.to))
    }
    if (!value) return Decoration.set(add, true)
    const mapped = changes ? value[key].map(changes) : value[key]
    const discard = new Set<Decoration>()
    let from = state.doc.length, to = 0
    for (const layout of removed) {
      for (let cursor = layout[key].iter(); cursor.value; cursor.next()) {
        discard.add(cursor.value)
        from = Math.min(from, changes ? changes.mapPos(cursor.from, -1) : cursor.from)
        to = Math.max(to, changes ? changes.mapPos(cursor.to, 1) : cursor.to)
      }
    }
    return !discard.size && !add.length ? mapped : mapped.update({
      filterFrom: from, filterTo: Math.max(from, to), filter: (_from, _to, deco) => !discard.has(deco), add, sort: true,
    })
  }
  return {
    decorations: update('decorations'), atomic: update('atomic'),
    blocks: layouts.flatMap(layout => layout.blocks), gaps: layouts.flatMap(layout => layout.gaps),
    cursorRanges: layouts.flatMap(layout => layout.cursorRanges),
    protected: [...(front ? [front] : []), ...math], parts, protection: protectedRanges,
  }
}

const paragraphLayoutField = StateField.define<IncrementalLayout>({
  create: state => updateLayout(state),
  update(value, tr) {
    // 刷新效果本身不改变排版；只处理文档变更或尚未纳入缓存的解析结果。
    return tr.docChanged || syntaxTree(tr.state) !== value.protection.tree
      || tr.state.facet(EditorView.blockWrappers) !== tr.startState.facet(EditorView.blockWrappers)
      ? updateLayout(tr.state, value, tr.changes) : value
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
})

// atomicRanges 管方向键；这里只修正直接交互产生的单光标落点。
// 程序定位、历史恢复和多选区的精确位置由调用方负责，不能按主光标猜方向。
const visibleSelection = EditorState.transactionFilter.of(tr => {
  if (!tr.selection && !tr.docChanged) return tr
  const event = tr.annotation(Transaction.userEvent)
  if (!(event === 'select' || event === 'select.pointer' || event === 'input.type'
    || event === 'input.paste' || event === 'input.drop' || tr.isUserEvent('delete'))
    || tr.startState.selection.ranges.length !== 1 || tr.newSelection.ranges.length !== 1) return tr
  const { cursorRanges, gaps } = tr.state.field(paragraphLayoutField)
  let changed = false
  const ranges = tr.newSelection.ranges.map(range => {
    if (!range.empty) return range
    const gap = cursorRanges.find(item => range.head > item.from && range.head < item.to)
    if (!gap) return range
    changed = true
    if (!tr.docChanged) {
      // 分隔画在上一段的行尾，End、点击行尾右侧都会落进来；按落点所在的视觉行取边界，
      // 不按移动方向猜，否则 End 会把光标送到下一段。隐藏的 # 则属于标题那一行。
      const sameLine = gaps.some(item => range.head > item.from && range.head <= item.to)
      return EditorSelection.cursor(sameLine ? gap.from : gap.to, sameLine ? -1 : 1)
    }
    const previous = tr.changes.mapPos(tr.startState.selection.main.head)
    // 编辑后的落点没有视觉行可依，沿编辑方向；删除会把旧光标映到新落点，
    // 两者相等时仍须保留退格的向后方向。
    const backward = range.head < previous || (range.head === previous && tr.isUserEvent('delete.backward'))
    return EditorSelection.cursor(backward ? gap.from : gap.to, backward ? -1 : 1)
  })
  return changed ? [tr, { sequential: true, selection: EditorSelection.create(ranges, tr.newSelection.mainIndex) }] : tr
})

function prosePosition(state: EditorState, pos: number): boolean {
  const { blocks, protected: protectedRanges } = state.field(paragraphLayoutField)
  if (protectedRanges.some(range => pos >= range.from && pos < range.to)) return false
  const block = blocks.find(item => pos >= item.from && pos <= item.to)
  if (block) return block.prose
  if (state.doc.lineAt(pos).text.trim() !== '') return false
  // 空行只有在普通正文之间或文末才接管；代码块、列表、引用里的 Enter 沿用已有行为。
  const before = blocks.findLast(item => item.to < pos)
  const after = blocks.find(item => item.from > pos)
  return (!before || before.prose) && (!after || after.prose)
    && (!before || /^[\s]*$/.test(state.doc.sliceString(before.to, pos)))
    && (!after || /^[\s]*$/.test(state.doc.sliceString(pos, after.from)))
}

function newParagraph(view: EditorView): boolean {
  const { state } = view
  const range = state.selection.main
  if (view.composing || state.readOnly || state.selection.ranges.length !== 1
    || !prosePosition(state, range.from) || !prosePosition(state, range.to)) return false
  const heading = range.empty && state.field(paragraphLayoutField).blocks.find(block =>
    block.heading && range.head === block.contentFrom)
  view.dispatch(state.update({
    changes: { from: heading ? heading.from : range.from, to: heading ? heading.from : range.to, insert: '\n\n' },
    selection: { anchor: range.from + 2 }, userEvent: 'input', scrollIntoView: true,
  }))
  return true
}

function headingBackspace(view: EditorView): boolean {
  const { state } = view
  const range = state.selection.main
  if (view.composing || state.readOnly || !range.empty || state.selection.ranges.length !== 1) return false
  const heading = state.field(paragraphLayoutField).blocks.find(block =>
    block.heading && block.contentFrom > block.from && range.head >= block.from && range.head <= block.contentFrom)
  if (!heading) return false
  // 标题开头先退成正文，再按一次才合并上一段，不能逐个删看不见的 #。
  view.dispatch({
    changes: { from: heading.from, to: heading.contentFrom },
    selection: { anchor: heading.from }, userEvent: 'delete.backward', scrollIntoView: true,
  })
  return true
}

function joinHeadingForward(view: EditorView): boolean {
  const { state } = view
  const range = state.selection.main
  if (view.composing || state.readOnly || !range.empty || state.selection.ranges.length !== 1) return false
  const { blocks, gaps } = state.field(paragraphLayoutField)
  const previous = blocks.findIndex(block => block.to === range.head)
  const next = blocks[previous + 1]
  if (previous < 0 || !blocks[previous].prose || !next?.heading || next.contentFrom === next.from) return false
  const adjacent = state.doc.sliceString(range.head, next.from) === '\n'
    || gaps.some(gap => gap.from === range.head && gap.right === next.from)
  if (!adjacent) return false
  // 向前合并时下一标题变成当前段的一部分，不把不可见的 ### 混进正文。
  view.dispatch({
    changes: { from: range.head, to: next.contentFrom },
    selection: { anchor: range.head }, userEvent: 'delete.forward', scrollIntoView: true,
  })
  return true
}

// moveVertically 落进隐藏区间时按移动方向整段跳过：下移越过行尾会跳到下一段，
// 上移到标题行首会退回上一段，中间那一行被整个略过；跳过之后的光标还丢了目标列。
// 落点停在区间端点上时自己落位：区间另一端单独占着起点与落点之间的那一行，就落到那一端。
function moveLine(view: EditorView, forward: boolean): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty || state.selection.ranges.length !== 1) return false
  const next = view.moveVertically(range, forward)
  const item = state.field(paragraphLayoutField).cursorRanges.find(gap => next.head === (forward ? gap.to : gap.from))
  // 没停在隐藏区间端点上就没有经过跳转，交回默认按键和其他扩展处理。
  if (!item) return false
  const start = view.coordsAtPos(range.head, range.assoc || 1)
  const landed = view.coordsAtPos(next.head, forward ? 1 : -1)
  const skipped = view.coordsAtPos(forward ? item.from : item.to, forward ? -1 : 1)
  // 只有隐藏 # 的标题，区间两端在同一行，不算跳过。
  const between = !!(start && landed && skipped) && (forward
    ? skipped.top >= start.bottom && skipped.bottom <= landed.top
    : skipped.bottom <= start.top && skipped.top >= landed.bottom)
  // 目标列按 moveVertically 的算法记下，连续移动才不会往行首漂。
  const goal = range.goalColumn ?? (start ? start.left - view.contentDOM.getBoundingClientRect().left : undefined)
  view.dispatch({
    // 要传 EditorSelection：单个 SelectionRange 会被当成 {anchor, head}，关联方向和目标列都丢掉。
    selection: EditorSelection.create([between
      ? EditorSelection.cursor(forward ? item.from : item.to, forward ? -1 : 1, undefined, goal)
      : EditorSelection.cursor(next.head, next.assoc, undefined, goal)]),
    scrollIntoView: true, userEvent: 'select',
  })
  return true
}

// 点击行尾右侧时，鼠标选区把隐藏区间里的落点推到较近的一端；分隔只有一个换行宽时
// 两端一样近，会推到下一段。单击落在上一段这一行时，起点直接定在上一段行尾。
const lineEndClick = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || event.detail !== 1 || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return null
  const start = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false)
  const gap = view.state.field(paragraphLayoutField).gaps.find(item => start.pos > item.from && start.pos <= item.to)
  if (!gap) return null
  let { from, to } = gap
  return {
    update(update) {
      if (update.docChanged) [from, to] = [update.changes.mapPos(from, -1), update.changes.mapPos(to, 1)]
    },
    get(current) {
      const { pos } = view.posAndSideAtCoords({ x: current.clientX, y: current.clientY }, false)
      // 仍在同一处隐藏区间里就是单击；拖出去之后才成为从行尾开始的选区。
      return EditorSelection.create([pos >= from && pos <= to
        ? EditorSelection.cursor(from, -1)
        : EditorSelection.range(from, pos)])
    },
  }
})

export const paragraphLayout: Extension = [
  paragraphLayoutField,
  lineEndClick,
  EditorView.atomicRanges.of(view => view.state.field(paragraphLayoutField).atomic),
  visibleSelection,
  Prec.high(keymap.of([
    { key: 'Enter', run: newParagraph },
    { key: 'Backspace', run: headingBackspace },
    { key: 'Delete', run: joinHeadingForward },
    { key: 'ArrowDown', run: view => moveLine(view, true) },
    { key: 'ArrowUp', run: view => moveLine(view, false) },
  ])),
]
