// 段落分隔只参与排版，不改源码。真正的空段落仍有正常行高。
// 跨行替换必须由 StateField 提供；光标同时把这些区间当作原子，避免盲打。
import { EditorSelection, EditorState, Prec, StateField, Transaction, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { decorationsRefreshEffect } from './live-preview'
import { excludedRanges, frontmatterRange, scanMath } from './math-scan'

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

function buildLayout(state: EditorState): Layout {
  const tree = syntaxTree(state)
  const text = state.doc.toString()
  const front = frontmatterRange(text)
  const math = scanMath(text, excludedRanges(text, tree)).filter(range => range.block)
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
  let previous: Block | null = null
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    // 属性区不参与正文排版；块公式可能横跨多个 Paragraph 节点，不能拆它内部的空行。
    if ((front && node.from < front.to) || math.some(range => node.from < range.to && node.to > range.from)
      || node.name === 'LinkReference') {
      previous = null
      continue
    }
    const first = state.doc.lineAt(node.from)
    const heading = /^ATXHeading([1-6])$/.exec(node.name)
    const marker = heading ? /^ {0,3}#{1,6}[ \t]+/.exec(first.text) : null
    const block: Block = {
      from: first.from,
      // HTMLBlock 的 to 可以恰好是下一行行首，不能把那一行分隔空行算进块里。
      to: state.doc.lineAt(Math.max(node.from, node.to - 1)).to,
      contentFrom: first.from + (marker?.[0].length ?? 0),
      heading: heading ? Number(heading[1]) : 0,
      prose: node.name === 'Paragraph' || !!heading,
    }
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
      decorations.push({
        from: block.from, to: block.from,
        value: Decoration.widget({ widget: new BlockSpace(emptyParagraph ? 0 : previous!.heading), block: true, side: -1 }),
      })
    }
    previous = block
  }
  // 文末保留可输入的空段落。一次 Enter 插入两个换行，屏幕上只新增一段。
  if (previous) {
    const tail = state.doc.sliceString(previous.to)
    if (/^\n{2,}$/.test(tail)) {
      separator(state.doc.lineAt(previous.to).number, state.doc.lines)
    }
  } else if (blocks.length === 0 && /^\n+$/.test(text)) {
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
    gaps, blocks, protected: [...(front ? [front] : []), ...math], cursorRanges,
  }
}

const paragraphLayoutField = StateField.define<Layout>({
  create: buildLayout,
  update(value, tr) {
    return tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)
      || tr.effects.some(effect => effect.is(decorationsRefreshEffect)) ? buildLayout(tr.state) : value
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
  const { cursorRanges } = tr.state.field(paragraphLayoutField)
  let changed = false
  const ranges = tr.newSelection.ranges.map(range => {
    if (!range.empty) return range
    const gap = cursorRanges.find(item => range.head > item.from && range.head < item.to)
    if (!gap) return range
    changed = true
    const previous = tr.changes.mapPos(tr.startState.selection.main.head)
    // 删除会把旧光标映到新落点；两者相等时仍须保留退格的向后方向。
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

export const paragraphLayout: Extension = [
  paragraphLayoutField,
  EditorView.atomicRanges.of(view => view.state.field(paragraphLayoutField).atomic),
  visibleSelection,
  Prec.high(keymap.of([
    { key: 'Enter', run: newParagraph },
    { key: 'Backspace', run: headingBackspace },
    { key: 'Delete', run: joinHeadingForward },
  ])),
]
