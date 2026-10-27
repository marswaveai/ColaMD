import { type SelectionRange, Annotation, ChangeSet, Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type ChangeSpec, type Line, type Range, type TransactionSpec } from '@codemirror/state'
import { BlockWrapper, Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type Rect, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { invertedEffects, isolateHistory, redo, selectAll, undo } from '@codemirror/commands'
import type { SyntaxNode, Tree } from '@lezer/common'
import { frontmatterRange, scanMath } from './math-scan'
import { isChinese } from '../ui-language'
import { linkTextRange, livePreviewField } from './live-preview'
import { unpairedBackticks, tableCodeSpans, tablePipes } from '../../shared/markdown-tables'
import { markdownParser } from './state'

export interface TableCell {
  /** 含两侧竖线的整格 */
  from: number
  to: number
  /** 竖线之间 */
  left: number
  right: number
  /** 去掉首尾空白后的内容 */
  start: number
  end: number
}

export interface TableRow {
  from: number
  to: number
  cells: TableCell[]
  trailing: boolean
}

export interface MarkdownTable {
  from: number
  to: number
  rows: TableRow[]
  delimiter: TableRow
  align: string[]
}

/** 数字与金额：放得下时不拆行，算最小列宽时按整段计 */
const NUMERIC = /^[+-]?\d[\d,.]*%?$/

const tableCache = new WeakMap<EditorState['doc'], Map<string, MarkdownTable>>()

/** 屏幕列宽按占比写；打印媒体按纸宽重新分配。wrapColumns 是数字也要拆行的列 */
interface TableLayout { width: number; columns: number[]; wrapColumns: number[] }
interface TableLayoutSnapshot extends TableLayout {
  length: number
  structure: string
  boundaries: number[]
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

function readRow(state: EditorState, node: SyntaxNode): TableRow {
  const text = state.sliceDoc(node.from, node.to)
  const pipes = node.name === 'TableDelimiter' ? tablePipes(text)
    : node.getChildren('TableDelimiter').map(marker => marker.from - node.from)
  const leading = pipes[0] === 0
  const trailing = pipes.at(-1) === text.length - 1
  const dividers = pipes.slice(leading ? 1 : 0, trailing ? -1 : undefined)
  const starts = [0, ...dividers]
  const ends = [...dividers, text.length]
  const cells = starts.map((from, index) => {
    const to = ends[index]
    const left = from + (text[from] === '|' ? 1 : 0)
    const right = to - (index === ends.length - 1 && trailing ? 1 : 0)
    const value = text.slice(left, right)
    const start = left + (value.match(/^[ \t]*/)?.[0].length ?? 0)
    const end = Math.max(start, right - (value.match(/[ \t]*$/)?.[0].length ?? 0))
    return { from: node.from + from, to: node.from + to, left: node.from + left, right: node.from + right, start: node.from + start, end: node.from + end }
  })
  return { from: node.from, to: node.to, cells, trailing }
}

function rowAlignment(state: EditorState, row: TableRow): string[] {
  return row.cells.map(cell => {
    const text = state.sliceDoc(cell.start, cell.end)
    return text.endsWith(':') ? (text.startsWith(':') ? 'center' : 'right') : 'left'
  })
}

export function readTable(state: EditorState, node: SyntaxNode): MarkdownTable {
  const key = `${node.from}:${node.to}`
  let cache = tableCache.get(state.doc)
  const cached = cache?.get(key)
  if (cached) return cached
  const rows: TableRow[] = []
  let delimiter!: TableRow
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableHeader' || child.name === 'TableRow') rows.push(readRow(state, child))
    else if (child.name === 'TableDelimiter') delimiter = readRow(state, child)
  }
  const align = rowAlignment(state, delimiter)
  const table = { from: node.from, to: node.to, rows, delimiter, align }
  if (!cache) tableCache.set(state.doc, cache = new Map())
  cache.set(key, table)
  return table
}

/** 分隔符不参与表格布局，但选区仍需要它的坐标。用相邻格子的边界代替隐藏元素的空矩形。 */
class TableBoundary extends WidgetType {
  constructor(readonly column: number, readonly end = false) { super() }
  eq(other: TableBoundary): boolean { return this.column === other.column && this.end === other.end }
  toDOM(): HTMLElement { return document.createElement('span') }
  coordsAt(dom: HTMLElement): Rect | null {
    const cell = dom.closest('.cm-md-table-row')?.querySelector<HTMLElement>(`.cm-md-table-cell[data-column="${this.column}"]`)
    if (!cell) return null
    const rect = cell.getBoundingClientRect()
    const x = this.end ? rect.right : rect.left
    return { left: x, right: x, top: rect.top, bottom: rect.bottom }
  }
}

class EmptyTableCell extends WidgetType {
  constructor(readonly column: number, readonly align: string, readonly allowInput: boolean, readonly header: boolean) { super() }
  eq(other: EmptyTableCell): boolean { return this.column === other.column && this.align === other.align && this.allowInput === other.allowInput && this.header === other.header }
  toDOM(view: EditorView): HTMLElement {
    const cell = document.createElement('span')
    cell.className = 'cm-md-table-cell'
    cell.dataset.column = String(this.column)
    cell.setAttribute('role', this.header ? 'columnheader' : 'cell')
    cell.style.textAlign = this.align
    const input = document.createElement('span')
    input.className = 'cm-md-table-input'
    input.contentEditable = String(this.allowInput)
    input.setAttribute('role', 'textbox')
    input.setAttribute('aria-label', isChinese() ? '单元格' : 'Cell')
    let committed = false
    const commit = (focus = true) => {
      if (committed || !input.isConnected || !input.textContent) return
      committed = true
      const { from, to } = view.state.selection.main
      insertCellText(view, from, to, input.textContent)
      if (focus) view.focus()
    }
    input.addEventListener('input', event => { if (!(event as InputEvent).isComposing) commit() })
    input.addEventListener('compositionend', () => { queueMicrotask(commit) })
    input.addEventListener('blur', () => commit(false))
    input.addEventListener('keydown', event => {
      if (event.isComposing) return
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        view.focus()
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') moveVertical(view, event.key === 'ArrowUp' ? -1 : 1, event.shiftKey)
        else moveAcrossCell(view, event.key === 'ArrowLeft' ? -1 : 1, event.shiftKey)
      } else if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        commit()
        view.focus()
        if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey) {
          const { from, to } = view.state.selection.main
          insertCellText(view, from, to, '\n')
        } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') insertRow(view, !event.shiftKey)
        else navigate(view, event.shiftKey ? -1 : 1, event.key === 'Enter')
      } else if (event.metaKey || event.ctrlKey) view.focus()
    })
    cell.appendChild(input)
    return cell
  }
  // 光标是格里一行字的高度，不是整格：整格的高度由同一行最高的那一格决定
  coordsAt(dom: HTMLElement): Rect {
    const rect = (dom.querySelector('.cm-md-table-input') ?? dom).getBoundingClientRect()
    const x = this.align === 'center' ? (rect.left + rect.right) / 2 : this.align === 'right' ? rect.right : rect.left
    return { left: x, right: x, top: rect.top, bottom: rect.bottom }
  }
  ignoreEvent(event: Event): boolean {
    return (event instanceof KeyboardEvent && event.isComposing) || (event.type !== 'mousedown' && event.type !== 'keydown' && event.type !== 'paste')
  }
}

interface TableParagraph {
  at: number
  side: -1 | 1
  gap: string
  returnTo: number
  /** 引用边界落点继续向外导航时也收起。 */
  dismissOutward?: boolean
}

/** 文档边界外的临时输入位置。只有确认输入后才把段落写进源码。 */
class TableParagraphInput extends WidgetType {
  constructor(readonly paragraph: TableParagraph, readonly allowInput: boolean) { super() }
  eq(other: TableParagraphInput): boolean { return this.paragraph === other.paragraph && this.allowInput === other.allowInput }
  toDOM(view: EditorView): HTMLElement {
    const block = document.createElement('div')
    block.className = 'cm-md-table-paragraph'
    const input = document.createElement('div')
    input.className = 'cm-md-table-paragraph-input'
    input.contentEditable = String(this.allowInput)
    input.tabIndex = -1
    input.setAttribute('role', 'textbox')
    input.setAttribute('aria-label', isChinese() ? '段落' : 'Paragraph')
    input.setAttribute('aria-readonly', String(!this.allowInput))
    let composing = false
    const active = () => input.isConnected && pendingParagraph(view.state) === this.paragraph
    const commit = (text: string) => {
      if (text && active() && insertParagraphText(view, text)) view.focus()
    }
    input.addEventListener('compositionstart', () => { composing = true })
    input.addEventListener('compositionend', event => {
      composing = false
      if (event.data) commit(input.textContent || event.data)
      else input.textContent = ''
    })
    input.addEventListener('input', event => {
      if (!composing && !(event as InputEvent).isComposing) commit(input.textContent ?? '')
    })
    input.addEventListener('beforeinput', event => {
      if (!this.allowInput) event.preventDefault()
    })
    input.addEventListener('paste', event => {
      event.preventDefault()
      commit(event.clipboardData?.getData('text/plain') ?? '')
    })
    input.addEventListener('blur', () => {
      // DOM 可能正随 setState 更新而移除；等本轮更新结束后再处理真正的失焦。
      queueMicrotask(() => {
        if (active() && document.activeElement !== input) view.dispatch({ selection: { anchor: this.paragraph.returnTo }, effects: setTableParagraph.of(null) })
      })
    })
    input.addEventListener('keydown', event => {
      if (event.isComposing || composing) return
      if ((event.metaKey || event.ctrlKey) && ['a', 'z'].includes(event.key.toLowerCase())) {
        event.preventDefault()
        event.stopPropagation()
        if (event.key.toLowerCase() === 'a') {
          returnFromParagraph(view, 0)
          selectAll(view)
        } else if (!view.state.readOnly && view.state.facet(EditorView.editable)) {
          if ((event.shiftKey ? redo : undo)(view) && !pendingParagraph(view.state)) view.focus()
        }
        return
      }
      const direction = ['ArrowLeft', 'ArrowUp', 'Backspace'].includes(event.key) ? -1
        : ['ArrowRight', 'ArrowDown', 'Delete'].includes(event.key) ? 1 : 0
      if (direction || event.key === 'Escape' || event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Enter') commit('\n')
        else returnFromParagraph(view, direction || (event.key === 'Tab' ? event.shiftKey ? -1 : 1 : 0))
      }
    })
    block.appendChild(input)
    return block
  }
  coordsAt(dom: HTMLElement): Rect {
    const rect = dom.getBoundingClientRect()
    return { left: rect.left, right: rect.left, top: rect.top, bottom: rect.bottom }
  }
  ignoreEvent(): boolean { return true }
}

function cellSyntax(tree: Tree, cell: TableCell): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(cell.start, 1)
  while (node && node.name !== 'TableCell' && node.from >= cell.left && node.to <= cell.right) node = node.parent
  return node?.name === 'TableCell' ? node : null
}

/** 代码、公式里的反斜杠原样保留。直接定位当前格的子树，避免每格重扫整张表。 */
function inVerbatim(state: EditorState, cell: TableCell, tree = syntaxTree(state)): (pos: number) => boolean {
  const code: { from: number; to: number }[] = []
  const excluded: { from: number; to: number }[] = []
  cellSyntax(tree, cell)?.cursor().iterate(node => {
    if (node.name === 'InlineCode') code.push({ from: node.from, to: node.to })
    if (node.name === 'InlineCode' || node.name === 'HTMLTag') excluded.push({ from: node.from - cell.start, to: node.to - cell.start })
  })
  const math = scanMath(state.sliceDoc(cell.start, cell.end), excluded)
    .map(range => ({ from: cell.start + range.from, to: cell.start + range.to }))
  const ranges = [...code, ...math]
  return pos => ranges.some(node => pos > node.from && pos < node.to)
}

/** 格子里只显示后一个字的转义（竖线、反斜杠、字面反引号）：返回隐藏的反斜杠位置。 */
function hiddenEscapes(state: EditorState, cell: TableCell, verbatim = inVerbatim(state, cell)): number[] {
  const code = tableCodeSpans(state.sliceDoc(cell.start, cell.end))
  let span = 0
  return [...state.sliceDoc(cell.start, cell.end).matchAll(/\\[\\|`]/g)]
    .map(match => cell.start + match.index!)
    .filter(pos => {
      while (span < code.length && pos >= cell.start + code[span].to) span++
      return !(code[span] && pos >= cell.start + code[span].from) &&
        (state.sliceDoc(pos + 1, pos + 2) === '|' || !verbatim(pos))
    })
}

type DecorationRange = { from: number; to: number; deco: Decoration }

function eachTable(state: EditorState, visit: (node: SyntaxNode) => void): void {
  const front = state.doc.sliceString(0, 3) === '---' ? frontmatterRange(state.doc.toString()) : null
  syntaxTree(state).iterate({ enter: node => {
    if (front && node.name !== 'Document' && node.from >= front.from && node.from < front.to) return false
    if (node.name === 'Table') { visit(node.node); return false }
    return ['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem'].includes(node.name)
  } })
}

interface TableRange { from: number; to: number; id: number }
let tableId = 0

function tableNodes(state: EditorState): SyntaxNode[] {
  const nodes: SyntaxNode[] = []
  eachTable(state, node => nodes.push(node))
  return nodes
}

function tableWrappers(state: EditorState, tables: TableRange[]) {
  const wrappers: Range<BlockWrapper>[] = []
  for (const node of tables) {
    const first = state.doc.lineAt(node.from).from
    const classes: string[] = []
    state.field(livePreviewField).between(first, first, (_from, _to, deco) => {
      classes.push(...(deco.spec.class ?? '').split(' ').filter((name: string) => name.startsWith('cm-md-page-') || name === 'cm-md-blockquote' || /^cm-md-li(?:-\d+)?$/.test(name)))
    })
    // wrapper 按块起点归属；终点取末行起点，文末临时段落不属于表格。
    wrappers.push(BlockWrapper.create({ tagName: 'div', attributes: { class: `cm-md-table-widget ${classes.join(' ')}`, 'data-table-id': String(node.id), role: 'table' } }).range(first, state.doc.lineAt(node.to).from))
  }
  return BlockWrapper.set(wrappers, true)
}

function decorateRow(state: EditorState, row: TableRow, rowIndex: number, align: string[], last: boolean,
  ranges: DecorationRange[], prefixes: Range<Decoration>[]): void {
  const columns = align.length
  const editable = state.facet(EditorView.editable) && !state.readOnly
  const line = state.doc.lineAt(row.from)
  ranges.push({ from: line.from, to: line.from, deco: Decoration.line({
    class: `cm-md-table-row${rowIndex === 0 ? ' cm-md-table-header' : ''}${last ? ' cm-md-table-last' : ''}`,
    attributes: { 'data-table-row': String(rowIndex), role: 'row' },
  }) })
  if (line.from < row.from) prefixes.push(Decoration.replace({ widget: new TableBoundary(0) }).range(line.from, row.from))
  row.cells.forEach((cell, column) => {
    if (column >= columns) {
      ranges.push({ from: cell.from, to: cell.to, deco: Decoration.mark({ class: 'cm-md-table-marker' }) })
      return
    }
    if (cell.start === cell.end) {
      const widget = new EmptyTableCell(column, align[column], editable, rowIndex === 0)
      ranges.push({ from: cell.from, to: cell.to, deco: cell.from < cell.to ? Decoration.replace({ widget }) : Decoration.widget({ widget, side: 1 }) })
      return
    }
    const text = state.sliceDoc(cell.start, cell.end)
    const numeric = NUMERIC.test(text)
    // 纸面重排时保留短编号/金额的最小词宽；长数字仍允许参与折行。
    const token = /^[A-Za-z0-9_.,%+-]{1,12}$/.test(text) && /\d/.test(text)
    ranges.push({ from: cell.from, to: cell.to, deco: Decoration.mark({ class: `cm-md-table-cell${numeric ? ' cm-md-table-number' : ''}${token ? ' cm-md-table-token' : ''}`, attributes: { 'data-column': String(column), role: rowIndex === 0 ? 'columnheader' : 'cell', style: `text-align:${align[column]}` } }) })
    const { left, right } = cell
    if (left > cell.from) ranges.push({ from: cell.from, to: left, deco: Decoration.replace({ widget: new TableBoundary(column) }) })
    if (right < cell.to) ranges.push({ from: right, to: cell.to, deco: Decoration.replace({ widget: new TableBoundary(column, true) }) })
    if (cell.start > left) ranges.push({ from: left, to: cell.start, deco: Decoration.mark({ class: 'cm-md-table-padding' }) })
    if (cell.end < right) ranges.push({ from: cell.end, to: right, deco: Decoration.mark({ class: 'cm-md-table-padding' }) })
    for (const from of hiddenEscapes(state, cell)) ranges.push({ from, to: from + 1, deco: Decoration.replace({}) })
  })
  for (let column = row.cells.length; column < columns; column++) {
    ranges.push({ from: row.to, to: row.to, deco: Decoration.widget({ widget: new EmptyTableCell(column, align[column], editable, rowIndex === 0), side: column + 1 }) })
  }
}

function tableDecorations(state: EditorState, nodes = tableNodes(state), previous: TableRange[] = []) {
  const identities = new Map(previous.map(table => [table.from, table.id]))
  const tables = nodes.map(({ from, to }) => ({ from, to, id: identities.get(from) ?? ++tableId }))
  const ranges: DecorationRange[] = []
  const prefixes: Range<Decoration>[] = []
  nodes.forEach(node => {
    const table = readTable(state, node)
    table.rows.forEach((row, index) => decorateRow(state, row, index, table.align, index === table.rows.length - 1, ranges, prefixes))
    const delimiter = state.doc.lineAt(table.delimiter.from)
    ranges.push({ from: delimiter.from, to: delimiter.from, deco: Decoration.line({ class: 'cm-md-table-delimiter' }) })
  })
  return { decorations: Decoration.set(ranges.map(range => range.deco.range(range.from, range.to)), true), prefixes: Decoration.set(prefixes, true), wrappers: tableWrappers(state, tables), tables }
}

function rowNodeAt(state: EditorState, pos: number): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side)
    while (node && node.name !== 'TableRow' && node.name !== 'TableHeader' && node.name !== 'Table') node = node.parent
    if (node?.name === 'TableRow' || node?.name === 'TableHeader') return node
  }
  return null
}

/** 表头和数据行的文字编辑只重画当前行，不读取整张表。 */
function changedTableRow(tr: Transaction): { before: SyntaxNode; after: SyntaxNode } | null {
  const edits: { from: number; to: number; next: number; plain: boolean }[] = []
  tr.changes.iterChanges((from, to, next, _end, inserted) => {
    edits.push({ from, to, next, plain: !/[|\\\r\n]/.test(tr.startState.sliceDoc(from, to) + inserted.toString()) })
  })
  if (edits.length !== 1 || !edits[0].plain) return null
  const { from, to, next } = edits[0]
  const before = rowNodeAt(tr.startState, from), after = rowNodeAt(tr.state, next)
  if (!before || !after || to > before.to || from < before.from || next < after.from) return null
  if (tr.changes.mapPos(before.parent!.from) !== after.parent!.from || tr.changes.mapPos(before.parent!.to) !== after.parent!.to) return null
  return { before, after }
}

const tableField = StateField.define<ReturnType<typeof tableDecorations>>({
  create: tableDecorations,
  update(value, tr) {
    const changed = tr.docChanged ? changedTableRow(tr) : null
    const tables = value.tables.map(table => ({ ...table, from: tr.changes.mapPos(table.from, -1), to: tr.changes.mapPos(table.to, 1) }))
    const mapped = { decorations: value.decorations.map(tr.changes), prefixes: value.prefixes.map(tr.changes),
      wrappers: tr.docChanged ? changed && tables.every((table, index) => table.from === value.tables[index].from)
        ? value.wrappers.map(tr.changes) : tableWrappers(tr.state, tables) : value.wrappers, tables }
    if (tr.state.field(tableComposition, false)) return mapped
    if (tr.startState.facet(EditorView.editable) !== tr.state.facet(EditorView.editable) || tr.startState.readOnly !== tr.state.readOnly) return tableDecorations(tr.state)
    const compositionEnded = tr.effects.some(effect => effect.is(setTableComposition) && !effect.value)
    const composition = tr.startState.field(tableComposition, false)
    const composedAt = composition?.changes.mapPos(composition.start.selection.main.head)
    if (!tr.docChanged && !compositionEnded && syntaxTree(tr.startState) === syntaxTree(tr.state)) return value
    if (changed && !compositionEnded) {
      const from = tr.state.doc.lineAt(changed.after.from).from, to = changed.after.to
      const ranges: DecorationRange[] = [], prefixes: Range<Decoration>[] = []
      let index = 0
      const previous = tr.startState.doc.lineAt(changed.before.from).from
      value.decorations.between(previous, previous, (_from, _to, deco) => {
        if (deco.spec.attributes?.['data-table-row']) index = Number(deco.spec.attributes['data-table-row'])
      })
      const delimiter = changed.after.parent!.getChild('TableDelimiter')!
      const align = rowAlignment(tr.state, readRow(tr.state, delimiter))
      const last = !changed.after.nextSibling || (changed.after.nextSibling.name === 'TableDelimiter' && !changed.after.nextSibling.nextSibling)
      decorateRow(tr.state, readRow(tr.state, changed.after), index, align, last, ranges, prefixes)
      const filter = (start: number) => start < from || start > to
      return { ...mapped,
        decorations: mapped.decorations.update({ filterFrom: from, filterTo: to, filter, add: ranges.map(range => range.deco.range(range.from, range.to)), sort: true }),
        prefixes: mapped.prefixes.update({ filterFrom: from, filterTo: to, filter, add: prefixes, sort: true }),
      }
    }
    // 只枚举容器下的表格边界；旧表消失、新表形成、后台解析推进都按范围差异更新。
    const nodes = tableNodes(tr.state)
    const oldByRange = new Map(tables.map((table, index) => [`${table.from}:${table.to}`, index]))
    const retained = new Set<number>()
    const rebuild = nodes.filter(node => {
      const index = oldByRange.get(`${node.from}:${node.to}`)
      if (index === undefined) return true
      const old = value.tables[index]
      if ((compositionEnded && composedAt !== undefined && composedAt >= old.from && composedAt <= old.to) || tr.changes.touchesRange(tr.startState.doc.lineAt(old.from).from, old.to)) return true
      retained.add(index)
      return false
    })
    const removed = tables.filter((_table, index) => !retained.has(index))
    if (!rebuild.length && !removed.length) return mapped
    const replacement = tableDecorations(tr.state, rebuild, tables)
    const nextByRange = new Map([...tables, ...replacement.tables].map(table => [`${table.from}:${table.to}`, table]))
    const nextTables = nodes.map(({ from, to }) => nextByRange.get(`${from}:${to}`)!)
    const affected = [...removed, ...rebuild].map(table => ({ from: tr.state.doc.lineAt(table.from).from, to: table.to }))
    const filter = (from: number, to: number) => !affected.some(table => from <= table.to && to >= table.from)
    const add = (set: DecorationSet) => { const ranges: Range<Decoration>[] = []; set.between(0, tr.state.doc.length, (from, to, deco) => { ranges.push(deco.range(from, to)) }); return ranges }
    return { decorations: mapped.decorations.update({ filter, add: add(replacement.decorations), sort: true }),
      prefixes: mapped.prefixes.update({ filter, add: add(replacement.prefixes), sort: true }),
      wrappers: tableWrappers(tr.state, nextTables), tables: nextTables }
  },
  // 格内替换不跨行，通过视图提供，避免高度树每键比较整表的行内替换。
  // 表格前缀优先于引用、列表标记；单元格仍包在行内装饰外面。
  provide: field => [EditorView.outerDecorations.of(view => view.state.field(field).decorations), Prec.high(EditorView.decorations.of(view => view.state.field(field).prefixes)), EditorView.blockWrappers.from(field, value => value.wrappers)],
})

// 身份随表格范围映射；正文编辑只改变位置，不更换 wrapper 或列宽选择器。
function tableDOMSelector(state: EditorState, from: number): string {
  const id = state.field(tableField).tables.find(table => table.from === from)?.id
  return `[data-table-id="${id}"]`
}

function tableDOMRange(view: EditorView, element: HTMLElement): TableRange | undefined {
  const id = Number(element.closest<HTMLElement>('.cm-md-table-widget')?.dataset.tableId)
  return view.state.field(tableField).tables.find(table => table.id === id)
}

let tableLayoutId = 0
const tableGeometry = new Compartment()
const tableGeometryTheme = EditorView.theme({})
const tableGeometryUpdate = Annotation.define<boolean>()

function tableLayoutSnapshot(table: MarkdownTable, layout: TableLayout): TableLayoutSnapshot {
  return {
    width: layout.width, columns: layout.columns, wrapColumns: layout.wrapColumns,
    length: table.to - table.from,
    structure: `${table.align.join(',')}/${table.rows.map(row => row.cells.length).join(',')}`,
    boundaries: table.rows.flatMap(row => row.cells.flatMap(cell => [cell.left - table.from, cell.right - table.from])),
  }
}

const tableLayout = ViewPlugin.fromClass(class {
  readonly id = String(++tableLayoutId)
  private readonly printMedia = window.matchMedia('print')
  private readonly style = document.createElement('style')
  private readonly measure = document.createElement('div')
  private readonly canvas = document.createElement('canvas').getContext('2d')!
  private readonly metrics = new Map<string, { min: number; max: number }>()
  private layouts = new Map<number, TableLayoutSnapshot>()
  private readonly rules = new Map<number, string>()
  private probes: { key: string; min: HTMLElement; max: HTMLElement }[] = []
  private signature = ''
  private numericCells = new Set<number>()

  constructor(private readonly view: EditorView) {
    this.measure.className = 'cm-content'
    this.measure.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;width:max-content;max-width:none;padding:0'
    this.measure.setAttribute('aria-hidden', 'true')
    view.dom.append(this.style, this.measure)
    this.schedule()
  }

  update(update: ViewUpdate): void {
    const reconfigured = update.transactions.some(tr => tr.reconfigured && !tr.annotation(tableGeometryUpdate))
    if (reconfigured) { this.signature = ''; this.numericCells.clear() }
    const composing = !!update.state.field(tableComposition, false)
    const compositionEnded = update.transactions.some(tr => tr.effects.some(effect => effect.is(setTableComposition) && !effect.value))
    if (update.docChanged) {
      const localRows = composing || update.transactions.every(tr => !tr.docChanged || !!changedTableRow(tr))
      this.numericCells = localRows && !composing ? new Set([...this.numericCells].map(pos => update.changes.mapPos(pos, -1))) : new Set()
      if (localRows && !composing) update.changes.iterChangedRanges((_from, _to, next, end) => {
        const cell = cellAround(update.state, next, end)
        if (cell && NUMERIC.test(update.state.sliceDoc(cell.start, cell.end))) this.numericCells.add(cell.left)
      })
      // 格内编辑只改变文字，沿用列宽；否则少一个字也会重分配整张表，把光标横向推走。
      // 映射各格的边界，只有格线、行列和对齐都没变时才保留布局。
      const retained = new Map<number, TableLayoutSnapshot>()
      const rules = new Map<number, string>()
      const retainRule = (from: number, mapped: number) => {
        const css = this.rules.get(from)
        if (css) rules.set(mapped, css)
      }
      for (const [from, layout] of this.layouts) {
        const mapped = update.changes.mapPos(from, -1)
        if (!update.changes.touchesRange(from, from + layout.length)) {
          retained.set(mapped, layout)
          retainRule(from, mapped)
          continue
        }
        if (localRows) {
          retained.set(mapped, { ...layout, length: update.changes.mapPos(from + layout.length, composing ? 1 : -1) - mapped,
            boundaries: layout.boundaries.map((pos, index) => update.changes.mapPos(from + pos, index % 2 ? 1 : -1) - mapped) })
          if (!composing) retainRule(from, mapped)
          continue
        }
        const next = tableAt(update.state, mapped)
        if (!next || next.from !== mapped) continue
        const snapshot = tableLayoutSnapshot(next, layout)
        if (snapshot.structure !== layout.structure || snapshot.boundaries.length !== layout.boundaries.length) continue
        // 无尾竖线时末格与表末重合；按新表末判断插入属于格内续写还是表外正文。
        const endAssoc = next.to === update.changes.mapPos(from + layout.length, -1) ? -1 : 1
        if (layout.boundaries.every((pos, index) => {
          const assoc = index % 2 ? (pos === layout.length ? endAssoc : 1) : -1
          return update.changes.mapPos(from + pos, assoc) - mapped === snapshot.boundaries[index]
        })) retained.set(mapped, snapshot)
      }
      this.layouts = retained
      this.rules.clear()
      for (const [from, css] of rules) this.rules.set(from, css)
    }
    if (!composing && (compositionEnded || reconfigured || update.docChanged || update.viewportChanged || update.geometryChanged)) this.schedule()
  }

  private layoutRules(from: number, layout: TableLayout): string {
    const table = `[data-table-layout="${this.id}"] ${tableDOMSelector(this.view.state, from)}`
    const total = sum(layout.columns)
    const rules = layout.columns.map((width, column) => `${table} .cm-md-table-cell[data-column="${column}"]{width:${width / total * 100}%}`)
    for (const column of layout.wrapColumns) rules.push(`${table} .cm-md-table-number[data-column="${column}"]{white-space:normal}`)
    return rules.join('\n')
  }

  private content(cell: TableCell): HTMLElement {
    const { state } = this.view
    const marks: { from: number; to: number; deco: Decoration }[] = []
    state.field(livePreviewField).between(cell.start, cell.end, (from, to, deco) => {
      if (from < to && from < cell.end && to > cell.start) marks.push({ from, to, deco })
    })
    const root = document.createElement('span')
    const hidden = new Set(hiddenEscapes(state, cell))
    const positions = [...new Set([cell.start, cell.end, ...marks.flatMap(mark => [Math.max(cell.start, mark.from), Math.min(cell.end, mark.to)])])].sort((a, b) => a - b)
    for (let i = 1; i < positions.length; i++) {
      const from = positions[i - 1], to = positions[i]
      const active = marks.filter(mark => mark.from <= from && mark.to >= to)
      const replacement = active.find(mark => !mark.deco.spec.class && !mark.deco.spec.tagName)
      if (replacement) {
        const widget = replacement.deco.spec.widget as WidgetType | undefined
        if (widget && from === replacement.from) {
          const source = state.sliceDoc(replacement.from, replacement.to)
          root.append('code' in widget || /^<br\s*\/?>$/i.test(source) ? widget.toDOM(this.view) : document.createTextNode(source))
        }
        continue
      }
      const span = document.createElement('span')
      span.className = active.map(mark => mark.deco.spec.class ?? '').join(' ')
      span.textContent = state.sliceDoc(from, to).split('').filter((_, index) => !hidden.has(from + index)).join('')
      root.appendChild(span)
    }
    return root
  }

  private schedule(): void {
    this.view.requestMeasure({ key: this, read: view => {
      // 打印分页期间重写屏幕百分比列宽会改变已分片表格的几何，可能丢掉末行。
      // 纸面由 print CSS 独立布局，屏幕测量与规则在退出打印后继续复用。
      if (this.printMedia.matches || view.state.field(tableComposition, false)) return null
      for (const probe of this.probes) this.metrics.set(probe.key, { min: probe.min.getBoundingClientRect().width, max: probe.max.getBoundingClientRect().width })
      const sample = view.contentDOM.querySelector<HTMLElement>('.cm-md-table-cell')
      if (!sample) {
        this.metrics.clear()
        return { doc: view.state.doc, layouts: [], pending: [], wrapping: [], checked: [] }
      }
      const style = getComputedStyle(sample)
      const signature = `${document.body.className}:${style.fontFamily}:${style.fontSize}:${style.letterSpacing}:${style.paddingLeft}:${style.paddingRight}:${style.minWidth}:${view.defaultCharacterWidth}`
      if (signature !== this.signature) {
        this.signature = signature
        this.metrics.clear()
        this.layouts.clear()
        this.rules.clear()
      }
      const pending = new Map<string, { cell: TableCell; header: boolean; font: string }>()
      const tables = new Map<number, number>()
      view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-table-row').forEach(row => {
        const wrapper = row.closest<HTMLElement>('.cm-md-table-widget')!
        const from = tableDOMRange(view, wrapper)?.from
        if (from === undefined) return
        if (tables.has(from)) return
        const wrapperStyle = getComputedStyle(wrapper)
        const parent = wrapper.parentElement!
        const parentStyle = getComputedStyle(parent)
        // 新数字还没放开换行时会暂时撑宽 table，不能把溢出后的宽度当作可用空间。
        const available = parent.clientWidth - parseFloat(parentStyle.paddingLeft) - parseFloat(parentStyle.paddingRight)
          - parseFloat(wrapperStyle.borderLeftWidth) - parseFloat(wrapperStyle.borderRightWidth)
        tables.set(from, Math.min(wrapper.clientWidth, available) - parseFloat(wrapperStyle.paddingLeft) - parseFloat(wrapperStyle.paddingRight))
      })
      const numeric = new Map<number, { pos: number; text: string; column: number; header: boolean }[]>()
      for (const pos of this.numericCells) {
        const node = rowNodeAt(view.state, pos)
        if (!node) continue
        const row = readRow(view.state, node)
        const column = row.cells.findIndex(cell => cell.left === pos)
        if (column < 0) continue
        const cell = row.cells[column], text = view.state.sliceDoc(cell.start, cell.end)
        const from = node.parent!.from
        const cells = numeric.get(from) ?? []
        cells.push({ pos, text, column, header: node.name === 'TableHeader' })
        numeric.set(from, cells)
      }
      const wrapping: { from: number; layout: TableLayoutSnapshot }[] = []
      const checked = [...numeric].filter(([from]) => tables.has(from)).flatMap(([, cells]) => cells.map(cell => cell.pos))
      const layouts: (TableLayout & { table: MarkdownTable })[] = []
      // 列宽快照和规则属于当前文档；仅内容度量随视口释放，不保留旧语法表对象。
      const usedMetrics = new Set<string>()
      for (const [from, width] of tables) {
        let cached = this.layouts.get(from)
        if (cached?.width === width && this.rules.has(from)) {
          const wrap = new Set(cached.wrapColumns)
          for (const cell of numeric.get(from) ?? []) {
            if (!NUMERIC.test(cell.text) || cell.column >= cached.columns.length || wrap.has(cell.column)) continue
            this.canvas.font = `${cell.header ? '600' : '400'} ${style.fontSize} ${style.fontFamily}`
            const required = this.canvas.measureText(cell.text).width + (parseFloat(style.letterSpacing) || 0) * cell.text.length
              + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 2
            if (required > cached.columns[cell.column]) wrap.add(cell.column)
          }
          // 列宽固定时，只需判断新数字是否超宽。已放开的列中，短数字仍不会换行；
          // 宽度、字体或结构变化时才重新计算整表的折行列。
          if (wrap.size !== cached.wrapColumns.length) wrapping.push({ from, layout: { ...cached, wrapColumns: [...wrap] } })
          continue
        }
        const table = tableAt(view.state, from)
        if (!table) continue
        if (cached && (cached.length !== table.to - table.from || !this.rules.has(table.from))) {
          const current = tableLayoutSnapshot(table, cached)
          const boundaries = cached.boundaries
          if (current.structure !== cached.structure || current.boundaries.length !== boundaries.length || current.boundaries.some((pos, index) => pos !== boundaries[index])) {
            this.layouts.delete(table.from)
            cached = undefined
          } else this.layouts.set(table.from, cached = current)
        }
        if (cached?.width === width && this.rules.has(table.from)) continue
        const minimum = table.align.map(() => parseFloat(style.minWidth))
        const preferred = [...minimum]
        // 数字也拆行时的下限
        const wrapped = [...minimum]
        table.rows.forEach((row, index) => row.cells.slice(0, table.align.length).forEach((cell, column) => {
          const text = view.state.sliceDoc(cell.start, cell.end)
          const header = index === 0
          const key = `${header}:${text}`
          usedMetrics.add(key)
          const font = `${header ? '600' : '400'} ${style.fontSize} ${style.fontFamily}`
          let metric = this.metrics.get(key)
          if (!metric && !/[\*_~`\[\]<>$\\&]/.test(text)) {
            this.canvas.font = font
            const measured = this.canvas.measureText(text).width + (parseFloat(style.letterSpacing) || 0) * text.length
            metric = { min: 0, max: measured }
            this.metrics.set(key, metric)
          }
          if (!metric) {
            pending.set(key, { cell, header, font })
            return
          }
          const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 2
          minimum[column] = Math.max(minimum[column], (NUMERIC.test(text) ? metric.max : metric.min) + padding)
          wrapped[column] = Math.max(wrapped[column], metric.min + padding)
          preferred[column] = Math.max(preferred[column], metric.max + padding)
        }))
        if (pending.size) continue
        if (cached?.width === width) {
          // 列宽不变，但新输入的数字仍可能超过这一列，需要独立更新换行规则。
          layouts.push({ ...cached, table, wrapColumns: minimum.flatMap((value, column) => value > cached.columns[column] ? [column] : []) })
          continue
        }
        // 整段数字放不下时，从最宽的数字列起放开拆行，一样宽的一起放开，直到放得下；放开的列退到
        // 拆行下限，空余再按理想宽度分。表格不撑出正文，一样长的数字拆得一样，短金额能不拆就不拆
        const floor = [...minimum]
        const wrapColumns: number[] = []
        for (const column of floor.map((_, column) => column).filter(column => minimum[column] > wrapped[column]).sort((a, b) => minimum[b] - minimum[a])) {
          const last = wrapColumns.at(-1)
          if (sum(floor) <= width && (last === undefined || minimum[last] - minimum[column] >= 1)) break
          floor[column] = wrapped[column]
          wrapColumns.push(column)
        }
        const free = Math.max(0, width - sum(floor))
        const flex = preferred.map((value, column) => value - floor[column])
        const total = sum(flex)
        // 放得下时先满足内容，再均分多余空间；只有空间不足时才按内容需求分配。
        const columns = floor.map((value, column) => value + (free >= total
          ? flex[column] + (free - total) / floor.length
          : free * flex[column] / total))
        layouts.push({ table, width, wrapColumns, columns })
      }
      if (usedMetrics.size) for (const key of this.metrics.keys()) if (!usedMetrics.has(key)) this.metrics.delete(key)
      return { doc: view.state.doc, layouts, wrapping, checked, pending: [...pending].map(([key, value]) => ({ key, ...value })) }
    }, write: plan => {
      if (this.printMedia.matches) return
      this.measure.replaceChildren()
      this.probes = []
      if (!plan || plan.doc !== this.view.state.doc) return
      for (const pos of plan.checked) this.numericCells.delete(pos)
      for (const { from, layout } of plan.wrapping) {
        this.layouts.set(from, layout)
        this.rules.set(from, this.layoutRules(from, layout))
      }
      for (const layout of plan.layouts) {
        this.layouts.set(layout.table.from, tableLayoutSnapshot(layout.table, layout))
        this.rules.set(layout.table.from, this.layoutRules(layout.table.from, layout))
      }
      const css = [...this.rules.values()].join('\n')
      if (this.style.textContent !== css) {
        this.style.textContent = css
        // 列边界变化未必改变行高。通过公开的 theme 重测路径刷新光标和选区的坐标；
        // 测量写阶段不能派发事务，等这一轮完成后再通知，不改动用户选区。
        queueMicrotask(() => {
          if (!this.style.isConnected) return
          const theme = tableGeometry.get(this.view.state) === tableGeometryTheme ? [] : tableGeometryTheme
          const range = this.view.state.selection.main
          const caret = currentCell(this.view.state) && this.view.coordsAtPos(range.head, range.assoc || 1)
          const viewport = this.view.scrollDOM.getBoundingClientRect()
          const selection = caret && caret.bottom >= viewport.top && caret.top <= viewport.bottom ? this.view.state.selection : undefined
          this.view.dispatch({ selection, effects: tableGeometry.reconfigure(theme), annotations: [tableGeometryUpdate.of(true), Transaction.addToHistory.of(false)], filter: false })
        })
      }
      for (const probe of plan.pending) {
        const row = document.createElement('div')
        row.className = `cm-md-table-row${probe.header ? ' cm-md-table-header' : ''}`
        row.style.display = 'block'
        const max = this.content(probe.cell)
        max.classList.add('cm-md-table-cell')
        max.style.cssText = `display:inline-block;width:max-content;min-width:0;padding:0;border:0;font:${probe.font}`
        const min = max.cloneNode(true) as HTMLElement
        min.style.width = 'min-content'
        row.append(min, max)
        this.measure.appendChild(row)
        this.probes.push({ key: probe.key, min, max })
      }
      if (this.probes.length) this.schedule()
    } })
  }

  destroy(): void {
    this.style.remove()
    this.measure.remove()
  }
}, { provide: plugin => EditorView.contentAttributes.of(view => ({ 'data-table-layout': view.plugin(plugin)?.id ?? '' })) })

function tableAt(state: EditorState, pos: number): MarkdownTable | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1)
  while (node && node.name !== 'Table') node = node.parent
  if (!node) {
    node = syntaxTree(state).resolveInner(pos, 1)
    while (node && node.name !== 'Table') node = node.parent
  }
  return node ? readTable(state, node) : null
}

const tableEdit = Annotation.define<boolean>()
// 整行移动、复制和缩进修改的是结构，不能当作单元格文字重写。
const cellEditEvents = ['input.type', 'input.paste', 'input.drop', 'delete', 'move.drop']
const isCellEdit = (tr: Transaction) => cellEditEvents.some(event => tr.isUserEvent(event))
const setVirtualCell = StateEffect.define<{ row: number; column: number } | null>({
  map: (value, changes) => value && ({ ...value, row: changes.mapPos(value.row, -1) }),
})
const virtualCell = StateField.define<{ row: number; column: number } | null>({
  create: () => null,
  update(value, tr) {
    const effect = tr.effects.find(effect => effect.is(setVirtualCell))
    return effect ? effect.value : tr.docChanged || tr.selection && !tr.annotation(tableGeometryUpdate) ? null : value
  },
})

const tableCellHistory = invertedEffects.of(tr => tr.docChanged && (tr.startState.field(virtualCell) || tr.effects.some(effect => effect.is(setVirtualCell)))
  ? [setVirtualCell.of(tr.startState.field(virtualCell))] : [])

const setTableParagraph = StateEffect.define<TableParagraph | null>({
  map: (paragraph, changes) => paragraph && ({
    ...paragraph,
    at: changes.mapPos(paragraph.at, paragraph.side),
    returnTo: changes.mapPos(paragraph.returnTo, -paragraph.side),
  }),
})

// 只把真实输入事务中的落点切换带进历史，单纯导航没有可撤销的事件。
const tableParagraphHistory = invertedEffects.of(tr => tr.docChanged && tr.effects.some(effect => effect.is(setTableParagraph))
  ? [setTableParagraph.of(pendingParagraph(tr.startState))] : [])
const tableParagraph = StateField.define<{ paragraph: TableParagraph | null; decorations: DecorationSet }>({
  create: () => ({ paragraph: null, decorations: Decoration.none }),
  update(value, tr) {
    const effect = tr.effects.find(effect => effect.is(setTableParagraph))
    const paragraph = effect ? effect.value : tr.docChanged || tr.selection && !tr.annotation(tableGeometryUpdate) ? null : value.paragraph
    if (paragraph === value.paragraph && !tr.reconfigured) return value
    return {
      paragraph,
      decorations: paragraph ? Decoration.set([Decoration.widget({
        widget: new TableParagraphInput(paragraph, tr.state.facet(EditorView.editable) && !tr.state.readOnly),
        block: true, side: paragraph.side,
      }).range(paragraph.at)]) : Decoration.none,
    }
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
})

function pendingParagraph(state: EditorState): TableParagraph | null {
  return state.field(tableParagraph, false)?.paragraph ?? null
}

// 标签恢复旧的状态快照时，不恢复曾经聚焦的临时 DOM 输入位置。
const tableParagraphLifecycle = ViewPlugin.fromClass(class {
  private destroyed = false
  constructor(private readonly view: EditorView) {
    const paragraph = pendingParagraph(view.state)
    if (paragraph) queueMicrotask(() => {
      if (!this.destroyed && pendingParagraph(view.state) === paragraph) view.dispatch({ selection: { anchor: paragraph.returnTo }, effects: setTableParagraph.of(null) })
    })
  }
  update(update: ViewUpdate): void {
    const paragraph = pendingParagraph(update.state)
    if (update.docChanged && paragraph && paragraph !== pendingParagraph(update.startState)) queueMicrotask(() => {
      if (!this.destroyed && pendingParagraph(this.view.state) === paragraph) focusParagraph(this.view)
    })
  }
  destroy(): void { this.destroyed = true }
})

// 空格子没有可放光标的字，输入由格里的临时输入框接收。焦点留在编辑器本体时，原生光标只能
// 放在替换部件之后，打的字会落进下一行，画出的光标也撑满整格。点击和方向键之外，删空格子、
// 撤销、查找、切换源码模式和恢复标签同样会把光标带进空格子，所以按状态统一交接：
// 选区或文档变化、焦点从编辑器外进入、状态整体替换之后各核对一次。焦点在编辑器内部从输入框
// 回到本体（格内按 ⌘ 组合键）不交回，否则快捷键落不到编辑器上。
const emptyCellFocus = ViewPlugin.fromClass(class {
  pending = true
  constructor(readonly view: EditorView) { this.schedule(view.state) }
  update(update: ViewUpdate): void {
    if (update.selectionSet || update.docChanged) this.pending = true
    // 目标行可能刚滚进视口还没绘制，之后的视口更新再试
    if (this.pending) this.schedule(update.state)
  }
  // 聚焦会触发 CodeMirror 的焦点处理，离开更新周期再做
  schedule(state: EditorState): void {
    queueMicrotask(() => {
      const { view } = this
      if (!this.pending || view.state !== state) return
      const current = state.selection.main.empty ? currentCell(state) : null
      if (view.root.activeElement !== view.contentDOM || !current || (current.cell && current.cell.start < current.cell.end)) {
        this.pending = false
        return
      }
      const input = view.contentDOM.querySelector<HTMLElement>(`${tableDOMSelector(view.state, current.table.from)} [data-table-row="${current.row}"] [data-column="${current.column}"] .cm-md-table-input`)
      if (!input) return
      this.pending = false
      if (input.isContentEditable) input.focus({ preventScroll: true })
    })
  }
}, {
  eventHandlers: {
    focus(event) {
      if (event.relatedTarget instanceof Node && this.view.dom.contains(event.relatedTarget)) return
      this.pending = true
      this.schedule(this.view.state)
    },
  },
})

function focusParagraph(view: EditorView): void {
  const paragraph = pendingParagraph(view.state)
  if (!paragraph) return
  view.focus()
  const focus = () => {
    if (pendingParagraph(view.state) === paragraph && view.dom.contains(document.activeElement)) {
      view.contentDOM.querySelector<HTMLElement>('.cm-md-table-paragraph-input')?.focus()
    }
  }
  focus()
  requestAnimationFrame(focus)
}

function insertParagraphText(view: EditorView, text: string): boolean {
  const paragraph = pendingParagraph(view.state)
  if (!paragraph) return false
  if (!text || view.state.readOnly || !view.state.facet(EditorView.editable)) return true
  const value = text.replace(/\r\n?/g, '\n')
  const insert = paragraph.side < 0 ? value + paragraph.gap : paragraph.gap + value
  view.dispatch({
    changes: { from: paragraph.at, insert },
    selection: { anchor: paragraph.at + (paragraph.side < 0 ? 0 : paragraph.gap.length) + value.length },
    effects: setTableParagraph.of(null),
    annotations: [tableEdit.of(true), isolateHistory.of('before')],
    userEvent: 'input.type', scrollIntoView: true,
  })
  return true
}

function returnFromParagraph(view: EditorView, direction: number): boolean {
  const paragraph = pendingParagraph(view.state)
  if (!paragraph) return false
  if (!direction || direction === -paragraph.side || paragraph.dismissOutward) {
    view.dispatch({ selection: { anchor: paragraph.returnTo }, effects: setTableParagraph.of(null), userEvent: 'select', scrollIntoView: true })
    view.focus()
  }
  return true
}

function currentCell(state: EditorState) {
  if (pendingParagraph(state)) return null
  const head = state.selection.main.head
  const node = rowNodeAt(state, head)
  if (node) {
    const target = readRow(state, node)
    const columns = readRow(state, node.parent!.getChild('TableDelimiter')!).cells.length
    const hint = state.field(virtualCell, false)
    const found = target.cells.findIndex(cell => head < cell.to || head === cell.end)
    const column = hint?.row === target.from ? hint.column
      : Math.min(columns - 1, found >= 0 ? found : target.trailing ? target.cells.length : target.cells.length - 1)
    return { get table() { return readTable(state, node.parent!) },
      get row() { return this.table.rows.findIndex(row => row.from === target.from) },
      column, cell: target.cells[column], target }
  }
  const table = tableAt(state, head)
  if (!table) return null
  let row = table.rows.findIndex(row => head <= row.to)
  if (row < 0) row = table.rows.length - 1
  const target = table.rows[row]
  const hint = state.field(virtualCell, false)
  const found = target.cells.findIndex(cell => head < cell.to || head === cell.end)
  const column = hint?.row === target.from ? hint.column
    : Math.min(table.align.length - 1, found >= 0 ? found : target.trailing ? target.cells.length : target.cells.length - 1)
  return { table, row, column, cell: target.cells[column], target }
}

// 光标贴住所在的格：紧凑表格 `|xy|zw|` 的格尾就是右侧竖线的位置，空格子的位置也常与下一格
// 左边的竖线重合。不贴住，光标会画到竖线之后，接着输入的字落进下一格。
function cellAssoc(cell: TableCell | undefined, head: number, state?: EditorState): -1 | 0 | 1 {
  if (!cell) return 0
  if (cell.start === cell.end) return head === cell.to ? -1 : 0
  if (state) {
    for (const side of [1, -1] as const) {
      const marker = syntaxTree(state).resolveInner(head, side)
      if (['CodeMark', 'EmphasisMark', 'StrikethroughMark'].includes(marker.name) &&
        (side > 0 ? marker.from === head && head > cell.start : marker.to === head && head < cell.end)) return side > 0 ? -1 : 1
    }
  }
  return head === cell.end ? -1 : head === cell.start ? 1 : 0
}

function cellSelection(state: EditorState, table: MarkdownTable, row: number, column: number, offset: number | 'end' = 0, select = false, goalColumn?: number): TransactionSpec {
  const target = table.rows[row]
  const cell = target.cells[column]
  const from = cell ? offset === 'end' ? cell.end : Math.max(cell.left, Math.min(cell.right, cell.start + offset)) : target.to
  const to = select ? cell?.end ?? target.to : from
  return {
    selection: from === to ? EditorSelection.create([EditorSelection.cursor(from, cellAssoc(cell, from, state), undefined, goalColumn)]) : EditorSelection.single(from, to),
    effects: setVirtualCell.of({ row: target.from, column }),
  }
}

function selectCell(view: EditorView, table: MarkdownTable, row: number, column: number, select = true, goalColumn?: number, scrollIntoView = true): void {
  view.dispatch({ ...cellSelection(view.state, table, row, column, 0, select, goalColumn), userEvent: 'select', scrollIntoView })
  const cell = table.rows[row].cells[column]
  // 空格子的输入框由 emptyCellFocus 接手，屏外的行等绘制出来再交
  if (!cell || cell.start === cell.end) view.focus()
}

function dispatchCellEdit(view: EditorView, transaction: Transaction): void {
  view.dispatch([transaction, transaction.state.update({
    selection: transaction.state.selection,
    effects: setVirtualCell.of(transaction.state.field(virtualCell)),
    userEvent: 'select',
    filter: false,
  })])
}

function editTable(view: EditorView, table: MarkdownTable, changes: ChangeSpec, row: number, column: number, anchor?: number, userEvent = 'input'): void {
  const next = view.state.update({ changes, filter: false })
  const updated = tableAt(next.state, next.changes.mapPos(table.from, -1))
  const target = updated?.rows[row]
  const selection = updated && target ? cellSelection(next.state, updated, row, column, anchor === undefined ? 'end' : anchor - (target.cells[column]?.start ?? target.to))
    : { selection: EditorSelection.create([EditorSelection.cursor(next.changes.mapPos(view.state.selection.main.head), -1)]) }
  const transaction = view.state.update({ changes, ...selection, annotations: [tableEdit.of(true), ...(userEvent === 'input.paste' ? [isolateHistory.of('full')] : [])], userEvent, scrollIntoView: true })
  dispatchCellEdit(view, transaction)
}

function rowText(state: EditorState, table: MarkdownTable): string {
  const line = state.doc.lineAt(table.delimiter.from)
  const prefix = state.sliceDoc(line.from, table.delimiter.from)
  return `${prefix}| ${table.align.map(() => '').join(' | ')} |`
}

function insertRow(view: EditorView, below = true, targetColumn?: number): boolean {
  const current = currentCell(view.state)
  if (!current || !view.state.facet(EditorView.editable) || view.state.readOnly) return false
  const { table, row, column } = current
  const after = below ? row : Math.max(0, row - 1)
  const from = after === 0 ? table.delimiter.to : table.rows[after].to
  editTable(view, table, { from, insert: `\n${rowText(view.state, table)}` }, after + 1, targetColumn ?? column)
  return true
}

/** 空行。引用里的空行只剩 `>`。 */
const blankLine = (text: string) => /^[\s>]*$/.test(text)

/** 分隔行相邻的表格位于哪一侧。源码解析归属是判断依据，渲染类不参与。 */
function adjacentTable(state: EditorState, line: Line): -1 | 1 | 0 {
  if (!blankLine(line.text)) return 0
  if (line.number > 1) {
    const above = state.doc.line(line.number - 1)
    const row = rowNodeAt(state, above.to)
    if (row && row.parent!.to === above.to) return -1
  }
  if (line.number < state.doc.lines && rowNodeAt(state, state.doc.line(line.number + 1).to)?.name === 'TableHeader') return 1
  return 0
}

/** 行里正文开始的地方：跳过引用、列表与标题的标记，免得字打进被藏起来的标记前面。 */
const textStart = (line: Line) => line.from + /^[ \t>]*(?:(?:[-*+]|\d+[.)]|#{1,6})[ \t]+)?/.exec(line.text)![0].length

/**
 * 光标离开 [from, to] 这张表格的落点。
 *
 * 紧挨着表格下面的一行一打字就会被并进表格当一行，所以要落在隔着空行的地方：
 * 向下是下一块的开头，向上是上一块的末尾，和渲染后看到的「上一段 / 下一段」一致。
 * 文档边界外先给一个临时输入位置，实际输入正文时才创建段落。
 */
function exitTable(state: EditorState, from: number, to: number, direction: number): TransactionSpec {
  const { doc } = state
  if (direction < 0) {
    const first = doc.lineAt(from)
    const above = first.number > 1 ? doc.line(first.number - 1) : null
    if (above && !blankLine(above.text)) return { selection: { anchor: above.to } }
    if (above && above.number > 1) return { selection: { anchor: doc.line(above.number - 1).to } }
    return { selection: { anchor: 0 }, effects: setTableParagraph.of({ at: 0, side: -1, gap: above ? '\n' : '\n\n', returnTo: state.selection.main.head }) }
  }
  const last = doc.lineAt(to)
  const below = last.number < doc.lines ? doc.line(last.number + 1) : null
  if (below && !blankLine(below.text)) return { selection: { anchor: textStart(below) } }
  if (below && below.number < doc.lines) return { selection: { anchor: textStart(doc.line(below.number + 1)) } }
  return { selection: { anchor: doc.length }, effects: setTableParagraph.of({ at: doc.length, side: 1, gap: below ? '\n' : '\n\n', returnTo: state.selection.main.head }) }
}

function leaveTable(view: EditorView, table: MarkdownTable, direction: number): void {
  const exit = exitTable(view.state, table.from, table.to, direction)
  view.dispatch({ ...exit, userEvent: 'select', scrollIntoView: true })
  focusParagraph(view)
}

function navigate(view: EditorView, direction: number, vertical = false): boolean {
  if (pendingParagraph(view.state)) return vertical ? insertParagraphText(view, '\n') : returnFromParagraph(view, direction)
  const current = currentCell(view.state)
  if (!current) return false
  const { table, row, column } = current
  if (vertical && direction > 0 && row > 0 && row === table.rows.length - 1 && table.rows[row].cells.every(cell => cell.start === cell.end)) {
    if (view.state.readOnly || !view.state.facet(EditorView.editable)) return true
    // 空末行按 Enter：删掉这一行，再按向下离开的规则落脚，一步撤销
    const remove = { changes: { from: view.state.doc.lineAt(table.rows[row].from).from - 1, to: table.to } }
    const removed = view.state.update(remove).state
    const end = remove.changes.from
    view.dispatch(view.state.update(remove, { ...exitTable(removed, table.from, end, 1), sequential: true, annotations: tableEdit.of(true), userEvent: 'input', scrollIntoView: true }))
    focusParagraph(view)
    return true
  }
  const index = row * table.align.length + column + (vertical ? direction * table.align.length : direction)
  if (index < 0) {
    leaveTable(view, table, -1)
  } else if (index >= table.rows.length * table.align.length) {
    return insertRow(view, true, vertical ? undefined : 0)
  } else {
    selectCell(view, table, Math.floor(index / table.align.length), index % table.align.length)
  }
  return true
}

function cellText(text: string): string {
  const value = text.replace(/\r\n?|\n/g, '<br>')
  const pipes = tablePipes(value)
  let from = 0, result = ''
  for (const pipe of pipes) { result += value.slice(from, pipe) + '\\|'; from = pipe + 1 }
  return pipes.length ? result + value.slice(from) : value
}

/** 结尾的反斜杠是否落单：落单的会和后面一个字组成转义 */
const loneSlash = (text: string) => /(?:^|[^\\])(?:\\\\)*\\$/.test(text)

function cellEditContext(state: EditorState, cell: TableCell) {
  const verbatim = inVerbatim(state, cell)
  const source = state.sliceDoc(cell.left, cell.right)
  const parity = new Uint8Array(source.length + 1)
  for (let i = 0; i < source.length; i++) parity[i + 1] = source[i] === '\\' ? 1 - parity[i] : 0
  const code = tableCodeSpans(state.sliceDoc(cell.start, cell.end))
  const inCode = (position: number) => {
    const pos = position - cell.start
    let left = 0, right = code.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (code[middle].from < pos) left = middle + 1
      else right = middle
    }
    return left > 0 && pos < code[left - 1].to
  }
  return { verbatim, source, parity, inCode, hidden: new Set(hiddenEscapes(state, cell, verbatim)) }
}

/**
 * 把格子里的一次改动换成按看到的字改原文：只显示一个字的转义对，删除时整对处理，选区端点
 * 停在一对中间时不越过看得见的那个字；新内容与两侧落单的反斜杠相接、会转义掉竖线（改变分格），
 * 或在代码外转义掉反斜杠、`<br>`（改变显示）时，补一个反斜杠。
 */
function prepareCellChange(cell: TableCell, context: ReturnType<typeof cellEditContext>, from: number, to: number, text: string) {
  const { verbatim, source, parity, inCode, hidden } = context
  const empty = from === to
  if (hidden.has(to - 1)) to = empty ? to - 1 : from === to - 1 ? to + 1 : to - 1
  if (hidden.has(from - 1)) from--
  const escapes = (pos: number, next: string) => !inCode(pos) && (next.startsWith('|') || (/^(?:\\|`|<br)/i.test(next) && !verbatim(pos)))
  let insert = inCode(from) && inCode(to) ? text.replace(/\r\n?|\n/g, '<br>') : cellText(text)
  const beforeOdd = !!parity[from - cell.left]
  if (beforeOdd && escapes(from, insert)) insert = `\\${insert}`
  const endsOdd = /^\\*$/.test(insert) ? beforeOdd !== loneSlash(insert) : loneSlash(insert)
  if (endsOdd && escapes(to, source.slice(to - cell.left, to - cell.left + 3))) insert += '\\'
  return { from, to, insert }
}

type CellTextEdit = { from: number; to: number; text: string }

function cellChanges(state: EditorState, cell: TableCell, edits: CellTextEdit[]) {
  const context = cellEditContext(state, cell)
  const changes = edits.map(edit => prepareCellChange(cell, context, edit.from, edit.to, edit.text))
  let candidate = '', copied = cell.left, cursor = cell.left
  for (const change of changes) {
    if (change.from < copied) return null
    candidate += state.sliceDoc(copied, change.from) + change.insert
    cursor = cell.left + candidate.length
    copied = change.to
  }
  candidate += state.sliceDoc(copied, cell.right)
  // 按整格复核，兼顾刚插入/删除反引号导致代码跨度变化的情况，再收回最小源码改动。
  const original = state.sliceDoc(cell.left, cell.right)
  let safe = cellText(candidate)
  cursor += tablePipes(candidate).filter(pipe => cell.left + pipe < cursor).length
  if (state.sliceDoc(cell.right, cell.right + 1) === '|' && loneSlash(safe)) {
    if (cursor === cell.left + safe.length) cursor++
    safe += '\\'
  }
  if (safe !== candidate || changes.length > 1) {
    if (safe === original) return safe === candidate ? { from: cell.left, to: cell.left, insert: '', cursor } : null
    let start = 0, end = original.length, nextEnd = safe.length
    while (start < end && start < nextEnd && original[start] === safe[start]) start++
    while (end > start && nextEnd > start && original[end - 1] === safe[nextEnd - 1]) { end--; nextEnd-- }
    return { from: cell.left + start, to: cell.left + end, insert: safe.slice(start, nextEnd), cursor }
  }
  return { ...changes[0], cursor }
}

function cellChange(state: EditorState, cell: TableCell, from: number, to: number, text: string) {
  return cellChanges(state, cell, [{ from, to, text }])
}

type TextChange = { from: number; to: number; insert: string }

/** 格线位置由调用方在拼接格子时记录，不能再由可能跨格的代码跨度反推。 */
function rowEscapePositions(text: string, pipes: number[]): number[] | null {
  const actual = tablePipes(text)
  if (actual.length === pipes.length && actual.every((pipe, index) => pipe === pipes[index])) return []
  const escapes: number[] = []
  let start = 0
  for (const end of [...pipes, text.length]) {
    for (const pos of unpairedBackticks(text.slice(start, end))) escapes.push(start + pos)
    start = end + 1
  }
  return escapes.length ? escapes : null
}

/** 追加源码格子，并记录新格线的位置；末尾已有的竖线可直接作为第一格的左边界。 */
function rowSuffix(values: string[], trailing: boolean): { text: string; pipes: number[] } {
  let text = trailing ? '' : ' |'
  const pipes = trailing ? [] : [text.length - 1]
  for (const value of values) {
    text += ` ${value} |`
    pipes.push(text.length - 1)
  }
  return { text, pipes }
}

/**
 * 改反引号可能让代码跨过原来的格线。先按各格编辑，再在受影响的行里复核格线位置。
 * 只有分格会变时，才把该行各格中原本没配对的反引号转义；完整代码与未编辑行不动。
 */
function preserveTableRows(state: EditorState, changes: TextChange[], rows: Set<number>, insertedPipes = new Map<TextChange, number[]>(), caret?: { position: number }): TextChange[] {
  const replaced = new Set<TextChange>()
  const repairs: TextChange[] = []
  const grouped = new Map<number, TextChange[]>()
  for (const change of changes) {
    const line = state.doc.lineAt(change.from)
    if (!rows.has(line.from) || change.to > line.to) continue
    const edits = grouped.get(line.from) ?? []
    edits.push(change)
    grouped.set(line.from, edits)
  }
  for (const [from, edits] of grouped) {
    const line = state.doc.lineAt(from)
    if (edits.some(change => change.insert.includes('\n'))) continue
    const original = line.text
    const set = state.changes(edits)
    const nextFrom = set.mapPos(line.from, -1)
    const expected = tablePipes(original).map(pipe => set.mapPos(line.from + pipe, 1) - nextFrom)
    for (const edit of edits) {
      const at = set.mapPos(edit.from, -1) - nextFrom
      expected.push(...(insertedPipes.get(edit) ?? []).map(pipe => at + pipe))
    }
    expected.sort((a, b) => a - b)
    let candidate = '', copied = line.from
    for (const edit of edits) { candidate += state.sliceDoc(copied, edit.from) + edit.insert; copied = edit.to }
    candidate += state.sliceDoc(copied, line.to)
    const positions = rowEscapePositions(candidate, expected)
    if (!positions) return []
    if (!positions.length) continue
    const escapes = positions.map(pos => ({ from: nextFrom + pos, to: nextFrom + pos, insert: '\\' }))
    // 组合源码改动而不把整行变成一次替换，光标与多选区仍能精确映射。
    const mapping = ChangeSet.of(escapes, set.newLength)
    if (caret) caret.position = mapping.mapPos(caret.position, 1)
    const repaired = set.compose(mapping)
    for (const edit of edits) replaced.add(edit)
    repaired.iterChanges((from, to, _fromB, _toB, inserted) => repairs.push({ from, to, insert: inserted.toString() }))
  }
  return [...changes.filter(change => !replaced.has(change)), ...repairs].sort((a, b) => a.from - b.from)
}

export interface TextMatch { from: number; to: number }
interface SearchCell { cell: TableCell; text: string; positions: number[] }
interface SearchTable { from: number; to: number; cells: SearchCell[] }
const searchTables = new WeakMap<EditorState['doc'], SearchTable[]>()

/** 搜索需要覆盖屏外表格；完整解析每个文档版本至多一次，后续关键词变化复用投影。 */
function tablesForSearch(state: EditorState): SearchTable[] {
  const cached = searchTables.get(state.doc)
  if (cached) return cached
  const parsed = syntaxTree(state)
  const tree: Tree = parsed.length === state.doc.length ? parsed : markdownParser.parse(state.doc.toString())
  const tables: SearchTable[] = []
  const front = frontmatterRange(state.doc.toString())
  tree.iterate({ enter(node) {
    if (front && node.name !== 'Document' && node.from >= front.from && node.from < front.to) return false
    if (node.name !== 'Table') return
    const table = readTable(state, node.node)
    const cells = table.rows.flatMap(row => row.cells.slice(0, table.align.length)).map(cell => {
      const source = state.sliceDoc(cell.start, cell.end)
      const hidden = new Set(hiddenEscapes(state, cell, inVerbatim(state, cell, tree)))
      // 格式标记切分文字节点，避免替换横跨标记后留下半个加粗或代码跨度。
      const marks = new Set<number>()
      const boundary = (from: number, to: number) => {
        for (let pos = from; pos < to; pos++) marks.add(pos)
      }
      cellSyntax(tree, cell)?.cursor().iterate(part => {
        if (part.name === 'Link') {
          const label = linkTextRange(state, part.node)
          if (label) { boundary(part.from, label.from); boundary(label.to, part.to) }
        } else if (['CodeMark', 'EmphasisMark', 'StrikethroughMark', 'HTMLTag', 'Image'].includes(part.name)) {
          boundary(part.from, part.to)
          return false
        }
      })
      const positions: number[] = []
      let text = ''
      for (let pos = cell.start; pos < cell.end; pos++) {
        if (hidden.has(pos)) continue
        positions.push(pos)
        text += marks.has(pos) ? '\u0000' : source[pos - cell.start]
      }
      return { cell, text, positions }
    })
    tables.push({ from: node.from, to: node.to, cells })
    return false
  } })
  searchTables.set(state.doc, tables)
  return tables
}

/** 表格内只匹配各单元格的文字，分隔行、格线和隐藏转义符不参与查找。 */
export function findTextMatches(state: EditorState, query: string): TextMatch[] {
  if (!query || query.includes('\u0000')) return []
  const matches: TextMatch[] = []
  const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const scan = (text: string, position: (index: number) => number) => {
    for (const match of text.matchAll(new RegExp(pattern, 'gi'))) {
      matches.push({ from: position(match.index!), to: position(match.index! + match[0].length - 1) + 1 })
    }
  }
  let copied = 0
  for (const table of tablesForSearch(state)) {
    const from = copied
    scan(state.sliceDoc(from, table.from), index => from + index)
    for (const cell of table.cells) scan(cell.text, index => cell.positions[index])
    copied = table.to
  }
  scan(state.sliceDoc(copied), index => copied + index)
  return matches
}

/** 同格的多个匹配一起复核转义，一次事务写回，避免全部替换产生重叠的源码改动。 */
export function replaceTextMatches(view: EditorView, matches: TextMatch[], text: string): void {
  if (view.state.readOnly || !view.state.facet(EditorView.editable)) return
  const tables = tablesForSearch(view.state)
  const grouped = new Map<TableCell, CellTextEdit[]>()
  const changes: { from: number; to: number; insert: string }[] = []
  const rows = new Set<number>()
  let tableIndex = 0, cellIndex = 0
  for (const match of matches) {
    while (tableIndex < tables.length && match.from >= tables[tableIndex].to) { tableIndex++; cellIndex = 0 }
    const table = tables[tableIndex]
    if (!table || match.to <= table.from) { changes.push({ ...match, insert: text }); continue }
    while (cellIndex < table.cells.length && match.from >= table.cells[cellIndex].cell.right) cellIndex++
    const cell = table.cells[cellIndex]?.cell
    if (!cell || !withinCell(cell, match.from, match.to)) continue
    const edits = grouped.get(cell) ?? []
    edits.push({ ...match, text })
    grouped.set(cell, edits)
    rows.add(view.state.doc.lineAt(cell.left).from)
  }
  for (const [cell, edits] of grouped) {
    const change = cellChanges(view.state, cell, edits)
    if (!change) return
    changes.push(change)
  }
  if (changes.length) view.dispatch({ changes: preserveTableRows(view.state, changes.sort((a, b) => a.from - b.from), rows), annotations: tableEdit.of(true), userEvent: 'input.replace' })
}

const unchanged = (change: { from: number; to: number; insert: string }, from: number, to: number, text: string) =>
  change.from === from && change.to === to && change.insert === text

/** 选区是否整个落在格里（不含两侧的竖线）。还没写进原文的格子只认空光标。 */
function withinCell(cell: TableCell | undefined, from: number, to: number): boolean {
  return cell ? from >= cell.left && to <= cell.right : from === to
}

/** [from, to] 整个落在哪一格的竖线之间 */
function cellAround(state: EditorState, from: number, to: number): TableCell | undefined {
  const node = rowNodeAt(state, from)
  if (!node || to > node.to) return undefined
  const columns = readRow(state, node.parent!.getChild('TableDelimiter')!).cells.length
  return readRow(state, node).cells.slice(0, columns).find(cell => withinCell(cell, from, to))
}

function insertCellText(view: EditorView, from: number, to: number, text: string, userEvent = 'input.type'): boolean {
  const current = currentCell(view.state)
  if (!current || !view.state.facet(EditorView.editable) || view.state.readOnly) return false
  const { cell } = current
  if (cell) {
    if (!withinCell(cell, from, to)) return false
    if (cell.start === cell.end && cell.left < cell.right) {
      // 只有空格的格子：写成 `| 内容 |`，不把字贴在右边的竖线上
      const value = cellText(text)
      const insert = ` ${value}${view.state.sliceDoc(cell.right, cell.right + 1) === '|' ? ' ' : ''}`
      const change = { from: cell.left, to: cell.right, insert }
      const caret = { position: view.state.changes(change).mapPos(cell.right, 1) - (insert.endsWith(' ') ? 1 : 0) }
      const changes = preserveTableRows(view.state, [change], new Set([view.state.doc.lineAt(cell.left).from]), undefined, caret)
      editTable(view, current.table, changes, current.row, current.column, caret.position, userEvent)
      return true
    }
    const change = cellChange(view.state, cell, from, to, text)
    if (!change) return true
    if (unchanged(change, from, to, text) && cell.start !== cell.end && userEvent !== 'input.paste') return false
    const caret = { position: change.cursor }
    const changes = preserveTableRows(view.state, [change], new Set([view.state.doc.lineAt(cell.left).from]), undefined, caret)
    editTable(view, current.table, changes, current.row, current.column, caret.position, userEvent)
  } else {
    const { table, row, column } = current
    const target = table.rows[row]
    const values = Array.from({ length: table.align.length - target.cells.length }, (_, i) => i + target.cells.length === column ? cellText(text) : '')
    const suffix = rowSuffix(values, target.trailing)
    const change = { from: target.to, to: target.to, insert: suffix.text }
    const changes = preserveTableRows(view.state, [change], new Set([view.state.doc.lineAt(target.from).from]), new Map([[change, suffix.pipes]]))
    editTable(view, table, changes, row, column, undefined, userEvent)
  }
  return true
}

function deleteAtBoundary(view: EditorView, direction: number): boolean {
  if (returnFromParagraph(view, direction)) return true
  const current = currentCell(view.state)
  if (!current) return false
  const range = view.state.selection.main
  return range.empty && (!current.cell || (direction < 0 ? range.head <= current.cell.start : range.head >= current.cell.end))
}

function deleteToCellEdge(view: EditorView, direction: number): boolean {
  if (pendingParagraph(view.state)) return true
  const current = currentCell(view.state)
  if (!current || !view.state.selection.main.empty) return false
  if (!current.cell) return true
  const head = view.state.selection.main.head
  const edge = direction < 0 ? current.cell.start : current.cell.end
  view.dispatch({ changes: { from: Math.min(head, edge), to: Math.max(head, edge), insert: '' }, selection: { anchor: Math.min(head, edge) }, userEvent: 'delete' })
  return true
}

function moveAcrossCell(view: EditorView, direction: number, extend = false): boolean {
  if (returnFromParagraph(view, direction)) return true
  const current = currentCell(view.state)
  if (!current || (!extend && !view.state.selection.main.empty)) return false
  const range = view.state.selection.main
  const { table, row, column, cell } = current
  if (cell && (direction < 0 ? view.state.selection.main.head > cell.start : view.state.selection.main.head < cell.end)) return false
  const index = row * table.align.length + column + direction
  if (index < 0 || index >= table.rows.length * table.align.length) {
    if (extend) {
      const pos = direction < 0 ? Math.max(0, view.state.doc.lineAt(table.from).from - 1) : Math.min(view.state.doc.length, table.to + 1)
      view.dispatch({ selection: { anchor: range.anchor, head: pos }, scrollIntoView: true })
    } else leaveTable(view, table, direction)
  } else {
    const r = Math.floor(index / table.align.length)
    const c = index % table.align.length
    const target = table.rows[r].cells[c]
    const pos = target ? direction < 0 ? target.end : target.start : table.rows[r].to
    if (extend) view.dispatch({ selection: { anchor: range.anchor, head: pos }, scrollIntoView: true })
    else if (!target || target.start === target.end) selectCell(view, table, r, c, false)
    else view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(pos, direction)]), scrollIntoView: true })
  }
  return true
}

function cellAtPoint(view: EditorView, event: Pick<MouseEvent, 'clientX' | 'clientY'>) {
  const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.cm-md-table-cell')
  const row = element?.closest<HTMLElement>('.cm-md-table-row')
  if (!element || !row) return null
  const source = tableDOMRange(view, row)
  const table = source && tableAt(view.state, source.from)
  const sourceRow = table?.rows[Number(row.dataset.tableRow)]
  if (!sourceRow) return null
  const cell = sourceRow.cells[Number(element.dataset.column)]
  if (!cell) return { pos: sourceRow.to, from: sourceRow.to, to: sourceRow.to }
  const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY)
  const range = caret ? null : document.caretRangeFromPoint?.(event.clientX, event.clientY)
  const node = caret?.offsetNode ?? range?.startContainer
  const offset = caret?.offset ?? range?.startOffset ?? 0
  const pos = node && view.contentDOM.contains(node) ? view.posAtDOM(node, offset) : cell.start
  const head = Math.max(cell.start, Math.min(cell.end, pos))
  return { pos: head, from: cell.start, to: cell.end, assoc: head === cell.end ? -1 : 1 }
}

/** 表格与引用的分隔只承载块间距。顶层其它普通分隔交给 paragraph-layout。
 * 只检查目标空行及其邻接块，不重建段落装饰；代码内、文档边界和真实空段仍可编辑。 */
function navigationSeparator(state: EditorState, line: Line): boolean {
  if (!blankLine(line.text)) return false
  const context = (pos: number): 'quote' | 'table' | null => {
    let quote = false, table = false
    for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'HTMLBlock') return null
      quote ||= node.name === 'Blockquote'
      table ||= node.name === 'Table'
    }
    return table ? 'table' : quote ? 'quote' : null
  }
  let before = line.number - 1, after = line.number + 1
  while (before > 0 && blankLine(state.doc.line(before).text)) before--
  while (after <= state.doc.lines && blankLine(state.doc.line(after).text)) after++
  if (!before || after > state.doc.lines || after - before > 3) return false
  if (line.text.includes('>')) return context(line.to) === 'quote'
  return !!(context(state.doc.line(before).to) || context(state.doc.line(after).to))
}

/** 公开几何移动先尊重其它扩展的 atomic 跳过，再对实际落到的分隔继续移动。 */
function movePastSeparators(view: EditorView, range: SelectionRange, direction: 1 | -1, moved = view.moveVertically(range, direction > 0)): SelectionRange {
  const caret = view.coordsAtPos(range.head, range.assoc || direction)
  const goal = range.goalColumn ?? (caret ? caret.left - view.contentDOM.getBoundingClientRect().left : undefined)
  while (navigationSeparator(view.state, view.state.doc.lineAt(moved.head))) {
    const next = view.moveVertically(EditorSelection.cursor(moved.head, direction, undefined, goal), direction > 0)
    if (direction > 0 ? next.head <= moved.head : next.head >= moved.head) break
    moved = next
  }
  return EditorSelection.cursor(moved.head, moved.assoc, undefined, goal)
}

function moveVertical(view: EditorView, direction: 1 | -1, extend = false): boolean {
  if (returnFromParagraph(view, direction)) return true
  const current = currentCell(view.state)
  if (!current) {
    const range = view.state.selection.main
    const first = view.state.doc.line(1)
    const caret = view.coordsAtPos(range.head)
    const firstStart = view.coordsAtPos(textStart(first))
    if (direction < 0 && !extend && range.empty && range.head <= first.to &&
      /^[ \t]*>/.test(first.text) && caret && firstStart && caret.top <= firstStart.top) {
      view.dispatch({ selection: { anchor: 0 }, effects: setTableParagraph.of({ at: 0, side: -1,
        gap: '\n\n', returnTo: range.head, dismissOutward: true }), userEvent: 'select' })
      focusParagraph(view)
      return true
    }
    // 扩展选区必须允许包含下一行的源码起点；吸附到正文会把下一项标记
    // 也选进去，整行删除时就会破坏列表。
    if (extend) return false
    // 原生移动可能停在列表/引用的隐藏标记内部；只归一化这类不可见前缀，
    // 其余正文与软换行仍交给 CM 的公开移动规则。
    const native = view.moveVertically(range, direction > 0)
    const moved = movePastSeparators(view, range, direction, native)
    const line = view.state.doc.lineAt(moved.head)
    const start = textStart(line)
    let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(Math.min(start, line.to), -1)
    while (node && node.name !== 'Blockquote' && node.name !== 'ListItem' && !/^ATXHeading/.test(node.name)) node = node.parent
    const skipped = moved.head !== native.head
    if (skipped || node && moved.head < start) {
      view.dispatch({ selection: EditorSelection.create([extend ? EditorSelection.range(range.anchor, Math.max(start, moved.head), moved.goalColumn)
        : EditorSelection.cursor(Math.max(start, moved.head), 1, undefined, moved.goalColumn)]), userEvent: 'select', scrollIntoView: true })
      return true
    }
    return false
  }
  const { table, row, column, cell } = current
  const range = view.state.selection.main
  const caret = view.coordsAtPos(range.head, range.assoc || 1)
  const goal = range.goalColumn ?? (caret ? caret.left - view.contentDOM.getBoundingClientRect().left : undefined)
  const edge = cell && view.coordsAtPos(direction < 0 ? cell.start : cell.end, direction < 0 ? 1 : -1)
  const element = (r: number) => view.contentDOM.querySelector<HTMLElement>(`${tableDOMSelector(view.state, table.from)} [data-table-row="${r}"] [data-column="${column}"]`)
  const own = element(row)
  const lineHeight = own ? Number.parseFloat(getComputedStyle(own).lineHeight) : 0
  let pos: number | null = null
  if (caret && edge && (direction < 0 ? caret.top > edge.top + lineHeight / 2 : caret.top < edge.top - lineHeight / 2)) {
    const point = cellAtPoint(view, { clientX: caret.left, clientY: (caret.top + caret.bottom) / 2 + direction * lineHeight })
    if (point && cell && point.pos >= cell.start && point.pos <= cell.end) pos = point.pos
  }
  if (pos === null || pos === range.head) {
    const next = row + direction
    if (next < 0 || next >= table.rows.length) {
      const boundary = view.state.doc.lineAt(direction < 0 ? table.from : table.to)
      if (direction < 0 ? boundary.number === 1 : boundary.number === view.state.doc.lines) {
        if (!extend) { leaveTable(view, table, direction); return true }
      }
      // 浏览与 Tab/Enter 都跨过分隔；方向键仍由真实几何保留目标横坐标。
      const moved = movePastSeparators(view, range, direction)
      pos = Math.max(textStart(view.state.doc.lineAt(moved.head)), moved.head)
    } else {
      const target = table.rows[next].cells[column]
      view.focus()
      if ((!target || target.start === target.end) && !extend) {
        selectCell(view, table, next, column, false, goal)
        return true
      }
      const el = element(next)
      const box = el?.getBoundingClientRect()
      const style = el && getComputedStyle(el)
      const left = box && style ? box.left + Number.parseFloat(style.paddingLeft) : 0
      const right = box && style ? box.right - Number.parseFloat(style.paddingRight) : 0
      const height = style ? Number.parseFloat(style.lineHeight) : 0
      const y = box && style ? (direction > 0 ? box.top + Number.parseFloat(style.paddingTop) + height / 2 : box.bottom - Number.parseFloat(style.paddingBottom) - height / 2) : 0
      const point = box && cellAtPoint(view, { clientX: Math.max(left, Math.min(right, goal === undefined ? left : view.contentDOM.getBoundingClientRect().left + goal)), clientY: y })
      pos = point?.pos ?? target?.start ?? table.rows[next].to
    }
  }
  view.dispatch({ selection: EditorSelection.create([extend ? EditorSelection.range(range.anchor, pos, goal) : EditorSelection.cursor(pos, rowNodeAt(view.state, pos) ? -1 : 1, undefined, goal)]), userEvent: 'select', scrollIntoView: true })
  return true
}

const setTableComposition = StateEffect.define<boolean>()
const tableComposition = StateField.define<{ start: EditorState; changes: ChangeSet } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setTableComposition)) return effect.value ? { start: tr.startState, changes: tr.startState.changes([]) } : null
    return value && tr.docChanged ? { start: value.start, changes: value.changes.compose(tr.changes) } : value
  },
})

const tableCompositionInput = ViewPlugin.fromClass(class {
  ending = false
  private queued = false
  private destroyed = false
  constructor(readonly view: EditorView) {
    if (view.state.field(tableComposition, false)) this.end()
  }
  update(update: ViewUpdate): void {
    if (this.ending && !update.view.compositionStarted) this.schedule()
  }
  finish(): void {
    this.ending = false
    const { view } = this
    const composition = view.state.field(tableComposition)
    if (!composition) return
    const changes: TextChange[] = [], rows = new Set<number>()
    composition.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      const cell = cellAround(composition.start, from, to)
      if (cell) rows.add(composition.start.doc.lineAt(cell.left).from)
      const change = cell ? cellChange(composition.start, cell, from, to, inserted.toString()) : { from, to, insert: inserted.toString() }
      if (change) changes.push(change)
    })
    const separated = changes.map(change => {
      const line = composition.start.doc.lineAt(change.from)
      const side = change.from === change.to ? adjacentTable(composition.start, line) : 0
      if (!side || !change.insert) return change
      const content = line.text.slice(0, change.from - line.from) + change.insert + line.text.slice(change.to - line.from)
      return { from: line.from, to: line.to, insert: side < 0 ? line.text + '\n' + content : content + '\n' + line.text }
    })
    const safe = composition.start.changes(preserveTableRows(composition.start, separated, rows))
    const repairs: TextChange[] = []
    composition.changes.invert(composition.start.doc).compose(safe).iterChanges((from, to, _next, _end, inserted) => {
      const before = view.state.sliceDoc(from, to), after = inserted.toString()
      let start = 0, end = before.length, nextEnd = after.length
      while (start < end && start < nextEnd && before[start] === after[start]) start++
      while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd-- }
      if (start < end || start < nextEnd) repairs.push({ from: from + start, to: from + end, insert: after.slice(start, nextEnd) })
    })
    // 只派发实际转义差异；整段先删后插会把组字末尾的光标映回开头。
    const repair = view.state.changes(repairs)
    dispatchCellEdit(view, view.state.update({ changes: repair, selection: view.state.selection.map(repair), effects: setTableComposition.of(false), annotations: tableEdit.of(true), userEvent: 'input.type.compose' }))
  }
  destroy(): void { this.destroyed = true }
  schedule(): void {
    if (this.queued) return
    this.queued = true
    const start = this.view.state.field(tableComposition, false)?.start
    // compositionend / input 所在任务的 DOM 变更先交给 MutationObserver 和 CM；
    // 再离开 update 收口。两层微任务覆盖事件之后才入队的 DOM 观察器，不依赖帧或延时。
    queueMicrotask(() => queueMicrotask(() => {
      this.queued = false
      if (!this.destroyed && this.ending && !this.view.compositionStarted &&
        this.view.state.field(tableComposition, false)?.start === start) this.finish()
    }))
  }
  end(): void {
    this.ending = true
    this.schedule()
  }
}, {
  eventHandlers: {
    compositionstart(event) {
      if (!(event.target instanceof HTMLElement) || event.target.closest('.cm-md-table-input') || (!cellAround(this.view.state, this.view.state.selection.main.from, this.view.state.selection.main.to) && !adjacentTable(this.view.state, this.view.state.doc.lineAt(this.view.state.selection.main.head)))) return
      this.finish()
      this.view.dispatch({ effects: setTableComposition.of(true) })
    },
    compositionend() { this.end() },
    input() { if (this.ending) this.schedule() },
    keydown(event) { if (this.ending && !event.isComposing && !this.view.compositionStarted) this.finish() },
    blur() { if (this.view.state.field(tableComposition, false)) this.end() },
  },
})

/** 切换标签、源码模式前提交当前 DOM 输入，快照不能带走未收口的组字状态。 */
export function finishTableComposition(view: EditorView): void {
  const input = view.dom.ownerDocument.activeElement
  // 空格和缺省格拥有独立输入节点；先通过它自己的 blur 提交，再读取标签或源码快照。
  if (input instanceof HTMLElement && input.closest('.cm-md-table-input') && view.contentDOM.contains(input)) input.blur()
  if (!view.state.field(tableComposition, false)) return
  view.contentDOM.blur()
  view.plugin(tableCompositionInput)?.finish()
}

/** 文字变更不碰格线和行内代码边界时，旧格可直接映射，不先构造会被过滤器丢弃的新状态。 */
function mappedSelectionCell(tr: Transaction): TableCell | undefined {
  let cell: TableCell | undefined, local = true
  tr.changes.iterChanges((from, to, _next, _end, inserted) => {
    const found = cellAround(tr.startState, from, to)
    if (!found || from < found.start || to > found.end ||
      /[|\\`\r\n]/.test(tr.startState.sliceDoc(from, to) + inserted.toString()) ||
      (cell && cell.left !== found.left)) local = false
    else cell = found
  })
  if (!local || !cell) return undefined
  const left = tr.changes.mapPos(cell.left, -1), right = tr.changes.mapPos(cell.right, 1)
  const text = tr.newDoc.sliceString(left, right)
  const start = left + (text.match(/^[ \t]*/)?.[0].length ?? 0)
  const end = Math.max(start, right - (text.match(/[ \t]*$/)?.[0].length ?? 0))
  const head = tr.newSelection.main.head
  if (head < left || head > right) return undefined
  // 无首尾竖线的单列表，删空内容可能让整行退出表格。
  const row = tr.newDoc.lineAt(left)
  if (!tr.newDoc.sliceString(row.from, left).includes('|') && !tr.newDoc.sliceString(right, row.to).includes('|')) return undefined
  return { from: tr.changes.mapPos(cell.from, -1), to: tr.changes.mapPos(cell.to, 1), left, right, start, end }
}

export const tableEditing = [
  tableComposition,
  tableCompositionInput,
  virtualCell,
  tableParagraph,
  tableParagraphHistory,
  tableCellHistory,
  tableParagraphLifecycle,
  emptyCellFocus,
  tableField,
  tableGeometry.of([]),
  tableLayout,
  // 点击仍可落在表外的分隔行。首次输入时保留这条分隔，避免正文被
  // Markdown 重新解析成表格行；纯导航不写源码。续引用与普通输入共用此规则。
  EditorState.transactionFilter.of(tr => {
    if (!tr.docChanged || !tr.isUserEvent('input') || tr.annotation(tableEdit) || tr.startState.field(tableComposition, false)) return tr
    let repair: { from: number; insert: string } | undefined
    let selection: EditorSelection | undefined
    tr.changes.iterChanges((from, to, next, _end, text) => {
      if (repair || from !== to || !text.length) return
      const line = tr.startState.doc.lineAt(from)
      const side = adjacentTable(tr.startState, line)
      if (side < 0) {
        repair = { from: next - (from - line.from), insert: line.text + '\n' }
      } else if (side > 0) {
        repair = { from: next + text.length + line.to - from, insert: '\n' + line.text }
        selection = tr.newSelection
      }
    })
    if (!repair) return tr
    const extra = tr.newDoc.length
    const mapping = ChangeSet.of(repair, extra)
    return {
      changes: tr.changes.compose(mapping),
      selection: selection ?? tr.newSelection.map(mapping),
      effects: tr.effects.map(effect => effect.map(mapping)).filter((effect): effect is StateEffect<unknown> => !!effect),
      annotations: [Transaction.userEvent.of(tr.annotation(Transaction.userEvent)!),
        Transaction.addToHistory.of(tr.annotation(Transaction.addToHistory) !== false)],
      scrollIntoView: tr.scrollIntoView,
    }
  }),
  EditorState.transactionFilter.of(tr => {
    if (!tr.selection || tr.startState.field(tableComposition, false) || tr.isUserEvent('input.type.compose') || tr.effects.some(effect => effect.is(setVirtualCell))) return tr
    const range = tr.newSelection.main
    const mapped = tr.docChanged ? mappedSelectionCell(tr) : undefined
    const current = mapped ? { cell: mapped, target: { to: mapped.right } } : currentCell(tr.state)
    if (!current) return tr
    const { target, cell } = current
    let head = range.head
    if (range.empty) head = cell ? Math.max(tr.docChanged ? cell.left : cell.start, Math.min(tr.docChanged ? cell.right : cell.end, head)) : target.to
    if (!tr.docChanged) {
      // 隐藏的转义符和它后面的字之间看不出位置：向右移一个字时越过这一对，其余落在它前面
      if (cell && hiddenEscapes(tr.state, cell).includes(head - 1)) {
        head += !tr.isUserEvent('select.pointer') && tr.startState.selection.main.head === head - 1 ? 1 : -1
      }
    }
    const assoc = (range.empty ? cellAssoc(cell, head, mapped ? undefined : tr.state) : 0) || range.assoc
    if (head === range.head && assoc === range.assoc) return tr
    const next = range.empty ? EditorSelection.cursor(head, assoc, range.bidiLevel ?? undefined, range.goalColumn) : EditorSelection.range(range.anchor, head, range.goalColumn, range.bidiLevel ?? undefined, assoc)
    return [tr, { selection: tr.newSelection.replaceRange(next), sequential: true }]
  }),
  EditorState.changeFilter.of(tr => {
    if (!isCellEdit(tr) || tr.startState.field(tableComposition, false)) return true
    if (tr.annotation(tableEdit)) return true
    let inside = true
    tr.changes.iterChangedRanges((from, to) => { if (!cellAround(tr.startState, from, to)) inside = false })
    if (inside) return true
    const table = tableAt(tr.startState, tr.startState.selection.main.head)
    if (!table) return true
    const selection = tr.startState.selection.main
    if (selection.from <= table.from && selection.to >= table.to) return true
    if (selection.empty && tr.isUserEvent('delete')) {
      const cell = currentCell(tr.startState)?.cell
      const left = cell?.start ?? selection.head
      const right = cell?.end ?? selection.head
      let crossesCell = false
      tr.changes.iterChangedRanges((from, to) => { if (from < left || to > right) crossesCell = true })
      if (crossesCell) return [0, left, right, tr.startState.doc.length]
    }
    const protectedRanges: number[] = []
    table.rows.forEach((row, index) => {
      for (const cell of row.cells) {
        if (tr.startState.sliceDoc(cell.from, cell.from + 1) === '|') protectedRanges.push(cell.from, cell.from + 1)
      }
      if (row.trailing) protectedRanges.push(row.to - 1, row.to)
      if (index < table.rows.length - 1) protectedRanges.push(row.to, table.rows[index + 1].from)
      else if (table.rows.length === 1) protectedRanges.push(row.to, table.to)
    })
    let touchesStructure = false
    tr.changes.iterChangedRanges((from, to) => {
      for (let i = 0; i < protectedRanges.length; i += 2) {
        if (from < protectedRanges[i + 1] && to > protectedRanges[i]) touchesStructure = true
      }
    })
    return touchesStructure ? protectedRanges : true
  }),
  // 删除、剪切、拖放和多光标编辑不经过 insertCellText，同样按看到的字改原文。组合输入期间不动，免得打断输入法
  EditorState.transactionFilter.of(tr => {
    if (!tr.docChanged || tr.annotation(tableEdit) || tr.startState.field(tableComposition, false) || tr.isUserEvent('input.type.compose') || !isCellEdit(tr)) return tr
    const changes: { from: number; to: number; insert: string }[] = []
    let caret: { position: number } | undefined
    let rewritten = false
    let rejected = false
    const rows = new Set<number>()
    tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      const text = inserted.toString()
      const cell = cellAround(tr.startState, from, to)
      if (cell) rows.add(tr.startState.doc.lineAt(cell.left).from)
      const change = cell ? cellChange(tr.startState, cell, from, to, text) : { from, to, insert: text }
      if (!change) { rejected = true; return }
      if ('cursor' in change && typeof change.cursor === 'number') caret = { position: change.cursor }
      rewritten ||= !unchanged(change, from, to, text)
      changes.push(change)
    })
    if (rejected) return []
    if (changes.some((change, index) => index && change.from < changes[index - 1].to)) return []
    if (changes.length !== 1 || tr.newSelection.ranges.length !== 1 || !tr.newSelection.main.empty) caret = undefined
    const safe = preserveTableRows(tr.startState, changes, rows, undefined, caret)
    rewritten ||= safe.length !== changes.length || safe.some((change, index) => !unchanged(change, changes[index].from, changes[index].to, changes[index].insert))
    if (!rewritten) return tr
    const set = tr.startState.changes(safe)
    // 单光标单处改动时光标落在新内容之后；多光标、拖动把原来的选区换算过来
    const mapPos = (pos: number, assoc: number) => set.mapPos(tr.changes.invertedDesc.mapPos(pos, assoc), assoc)
    const selection = caret || safe.length === 1 && tr.newSelection.ranges.length === 1 && tr.newSelection.main.empty
      ? EditorSelection.create([EditorSelection.cursor(caret?.position ?? mapPos(tr.newSelection.main.head, 1), -1)])
      : EditorSelection.create(tr.newSelection.ranges.map(range => range.empty
        ? EditorSelection.cursor(mapPos(range.head, range.assoc || 1), range.assoc)
        : EditorSelection.range(mapPos(range.anchor, range.anchor < range.head ? -1 : 1), mapPos(range.head, range.anchor < range.head ? 1 : -1))), tr.newSelection.mainIndex)
    const history = tr.annotation(Transaction.addToHistory)
    return {
      changes: set,
      selection,
      effects: StateEffect.mapEffects(StateEffect.mapEffects(tr.effects, tr.changes.invertedDesc), set),
      annotations: history === undefined ? [] : Transaction.addToHistory.of(history),
      userEvent: tr.annotation(Transaction.userEvent),
      scrollIntoView: tr.scrollIntoView,
    }
  }),
  Prec.highest(keymap.of([
    { key: 'Tab', run: view => navigate(view, 1) },
    { key: 'Shift-Tab', run: view => navigate(view, -1) },
    { key: 'Enter', run: view => navigate(view, 1, true) },
    { key: 'Mod-Enter', run: view => insertRow(view) },
    { key: 'Mod-Shift-Enter', run: view => insertRow(view, false) },
    { key: 'Shift-Enter', run: view => {
      if (insertParagraphText(view, '\n')) return true
      if (!currentCell(view.state)) return false
      const { from, to } = view.state.selection.main
      return insertCellText(view, from, to, '\n')
    } },
    { key: 'Backspace', run: view => deleteAtBoundary(view, -1) },
    { key: 'Delete', run: view => deleteAtBoundary(view, 1) },
    { mac: 'Alt-Backspace', win: 'Ctrl-Backspace', linux: 'Ctrl-Backspace', run: view => deleteAtBoundary(view, -1) },
    { mac: 'Alt-Delete', win: 'Ctrl-Delete', linux: 'Ctrl-Delete', run: view => deleteAtBoundary(view, 1) },
    { mac: 'Mod-Backspace', run: view => deleteToCellEdge(view, -1) },
    { mac: 'Mod-Delete', run: view => deleteToCellEdge(view, 1) },
    { key: 'ArrowLeft', run: view => moveAcrossCell(view, -1) },
    { key: 'ArrowRight', run: view => moveAcrossCell(view, 1) },
    { key: 'Shift-ArrowLeft', run: view => moveAcrossCell(view, -1, true) },
    { key: 'Shift-ArrowRight', run: view => moveAcrossCell(view, 1, true) },
    { key: 'ArrowUp', run: view => moveVertical(view, -1) },
    { key: 'ArrowDown', run: view => moveVertical(view, 1) },
    { key: 'Shift-ArrowUp', run: view => moveVertical(view, -1, true) },
    { key: 'Shift-ArrowDown', run: view => moveVertical(view, 1, true) },
    { key: 'Escape', run: view => returnFromParagraph(view, 0) },
  ])),
  EditorView.inputHandler.of((view, from, to, text) => view.composing ? false : insertParagraphText(view, text) || insertCellText(view, from, to, text)),
  EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey) return null
    const point = cellAtPoint(view, event)
    if (!point) return null
    let anchor = point.pos
    let initial = view.state.selection
    const start = event.detail >= 3 ? point : event.detail === 2 ? view.state.wordAt(anchor) : null
    return {
      get(current, extend, multiple) {
        const target = cellAtPoint(view, current)
        let head = target?.pos ?? view.posAtCoords({ x: current.clientX, y: current.clientY }) ?? anchor
        let from = extend ? initial.main.anchor : anchor
        if (start) {
          const end = event.detail >= 3 ? target : view.state.wordAt(head)
          from = head < anchor ? start.to : start.from
          head = head < anchor ? (end?.from ?? head) : (end?.to ?? head)
        }
        const range = EditorSelection.range(from, head, undefined, undefined, target?.assoc)
        return multiple ? initial.addRange(range) : EditorSelection.create([range])
      },
      update(update) {
        anchor = update.changes.mapPos(anchor)
        initial = initial.map(update.changes)
      },
    }
  }),
  EditorView.domEventHandlers({
    beforeinput(event, view) {
      if (event.isComposing || !event.data || !/[\n|]/.test(event.data)) return false
      const { from, to } = view.state.selection.main
      if (!insertCellText(view, from, to, event.data)) return false
      event.preventDefault()
      return true
    },
    mousedown(event, view) {
      if (event.button !== 0 || !(event.target instanceof HTMLElement)) return false
      const cell = event.target.closest<HTMLElement>('.cm-md-table-cell')
      const row = cell?.closest<HTMLElement>('.cm-md-table-row')
      if (!cell || !row) return false
      const range = tableDOMRange(view, row)
      const table = range && tableAt(view.state, range.from)
      if (!table) return false
      const rowIndex = Number(row.dataset.tableRow)
      const column = Number(cell.dataset.column)
      const target = table.rows[rowIndex].cells[column]
      if (target && target.start !== target.end) return false
      event.preventDefault()
      if (target) {
        const anchor = Math.max(target.start, Math.min(target.end, view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? target.start))
        view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(anchor, cellAssoc(target, anchor, view.state))]), effects: setVirtualCell.of({ row: table.rows[rowIndex].from, column }) })
      } else selectCell(view, table, rowIndex, column, false, undefined, false)
      const input = cell.querySelector<HTMLElement>('.cm-md-table-input')
      if (input) input.focus({ preventScroll: true })
      else view.focus()
      return true
    },
    paste(event, view) {
      if (pendingParagraph(view.state)) {
        event.preventDefault()
        insertParagraphText(view, event.clipboardData?.getData('text/plain') ?? '')
        view.focus()
        return true
      }
      const current = currentCell(view.state)
      const text = event.clipboardData?.getData('text/plain')
      if (!current || text === undefined || !view.state.facet(EditorView.editable) || view.state.readOnly) return false
      if (!text.includes('\t')) {
        const { from, to } = view.state.selection.main
        if (!insertCellText(view, from, to, text, 'input.paste')) return false
        view.focus()
        event.preventDefault()
        return true
      }
      // 选区伸到格外（从正文拖进表格、全选）时不当表格数据展开，交给常规粘贴
      const { from, to } = view.state.selection.main
      if (!withinCell(current.cell, from, to)) return false
      const { table, row, column } = current
      const values = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(line => line.split('\t'))
      const columns = Math.max(table.align.length, column + Math.max(...values.map(row => row.length)))
      const changes: TextChange[] = []
      const protectedRows = new Set<number>()
      const insertedPipes = new Map<TextChange, number[]>()
      const rows = [...table.rows, table.delimiter]
      for (let r = 0; r < rows.length; r++) {
        const target = rows[r]
        const index = r === table.rows.length ? -1 : r
        for (let c = 0; c < Math.min(target.cells.length, columns); c++) {
          const value = values[index - row]?.[c - column]
          if (index >= row && c >= column && value !== undefined) {
            const change = cellChange(view.state, target.cells[c], target.cells[c].start, target.cells[c].end, value)
            if (!change) { event.preventDefault(); return true }
            changes.push(change)
            protectedRows.add(view.state.doc.lineAt(target.from).from)
          }
        }
        if (target.cells.length < columns) {
          const extra = Array.from({ length: columns - target.cells.length }, (_, i) => {
            const c = i + target.cells.length
            return index < 0 ? '---' : cellText(values[index - row]?.[c - column] ?? '')
          })
          const suffix = rowSuffix(extra, target.trailing)
          const change = { from: target.to, to: target.to, insert: suffix.text }
          changes.push(change)
          if (index >= 0) {
            protectedRows.add(view.state.doc.lineAt(target.from).from)
            insertedPipes.set(change, suffix.pipes)
          }
        }
      }
      const safe = preserveTableRows(view.state, changes.sort((a, b) => a.from - b.from), protectedRows, insertedPipes)
      if (!safe.length) { event.preventDefault(); return true }
      const prefix = view.state.sliceDoc(view.state.doc.lineAt(table.delimiter.from).from, table.delimiter.from)
      let added = ''
      for (let r = table.rows.length; r < row + values.length; r++) {
        const suffix = rowSuffix(Array.from({ length: columns }, (_, c) => cellText(values[r - row]?.[c - column] ?? '')), true)
        const text = `${prefix}|${suffix.text}`
        const escapes = new Set(rowEscapePositions(text, [prefix.length, ...suffix.pipes.map(pipe => prefix.length + 1 + pipe)]))
        added += '\n' + text.split('').map((char, index) => (escapes.has(index) ? '\\' : '') + char).join('')
      }
      if (added) safe.push({ from: table.to, to: table.to, insert: added })
      editTable(view, table, safe, row + values.length - 1, column + values.at(-1)!.length - 1, undefined, 'input.paste')
      view.focus()
      event.preventDefault()
      return true
    },
  }),
]
