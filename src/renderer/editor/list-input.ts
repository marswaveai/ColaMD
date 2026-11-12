// 列表与引用的输入手感。
//
// markdown 是纯文本，`- 文案` 就是一个减号加一段文字，渲染层只负责把它画成圆点。
// 但「回车自动续下一条」「在标记后面退格」「Tab 改列表层级」是编辑器该做的事，跟渲染无关。
//
// 基础续行交给 CodeMirror 的 markdown 语言包自带命令（2026-11-07 定）：
//   insertNewlineContinueMarkupCommand({ nonTightLists: false })
//   deleteMarkupBackward
//
// 在此之上补齐 Obsidian / Typora 实时预览与官方默认不同的四处边界：
//   1. 渲染模式下列表标记和前导空格都是藏起来的，光标落在正文首字前就等于在行首（design.md）：
//      退格应该先拆任务框 → 退一级缩进 → 拆列表标记（不留一串空格）→ 拆引用标记 → 最后才粘行。
//   2. 所有列表操作（退格、Tab、Shift+Tab）都要认行首的引用前缀 `> `：在 `> - 甲` 上按 Tab
//      缩进的是引用里面的列表（`>   - 甲`），不能往 `>` 左边塞空格把引用打碎成代码块。
//   3. 空引用行 `> ` 上按一次回车直接退出引用（官方命令默认要连续两行空引用才退）。
//   4. 已经顶格退出了列表的普通行，回车不让上一行的列表按懒续行塞缩进空格。

import { EditorView, keymap } from '@codemirror/view'
import { Prec, type EditorState, type Extension } from '@codemirror/state'
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown'

/** 引用前缀：每层 `>` 最多吃掉后面紧跟的一个空格，其余空格归列表缩进。 */
const QUOTE_PREFIX_RE = /^(?:[ \t]*> ?)+/

/**
 * 剥掉引用前缀后的列表行：缩进 + 标记 + 空白 + 可选的任务框。
 * 分组：1 缩进、2 无序标记、3 有序号、4 序号后缀、5 标记后的空白、6 任务框。
 */
const LIST_BODY_RE = /^([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/

/** 一级缩进的宽度。两个空格：`- ` 正好是两个字符，也和我们文档里的写法一致。 */
const INDENT = '  '

interface ParsedListLine {
  /** 引用前缀长度（无引用时为 0），如 `"> - 甲"` 与 `">   - 乙"` 均为 2 */
  quoteLen: number
  /** 引用层数（`>` 的个数），父子项必须在同一层引用里才能互认 */
  quoteDepth: number
  /** 引用前缀之后的列表缩进宽度 */
  lead: number
  /** 列表标记宽度（含标记后空白，不含缩进与任务框） */
  width: number
  /** 有序项的序号原文，无序项为空串 */
  digits: string
  /** 任务框及后随空白（如 `"[ ] "`），无则为空串 */
  box: string
  /** 整段标记前缀总长度（quoteLen + lead + 标记 + 空白 + 任务框），即正文起始偏移 */
  contentOffset: number
}

function countQuotes(prefix: string): number {
  let count = 0
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] === '>') count++
  }
  return count
}

function parseListLine(text: string): ParsedListLine | null {
  const quotePrefix = QUOTE_PREFIX_RE.exec(text)?.[0] ?? ''
  const quoteLen = quotePrefix.length
  const match = LIST_BODY_RE.exec(text.slice(quoteLen))
  if (!match) return null
  const lead = match[1].length
  const box = match[6] ?? ''
  const width = match[0].length - lead - box.length
  return {
    quoteLen,
    quoteDepth: countQuotes(quotePrefix),
    lead,
    width,
    digits: match[3] ?? '',
    box,
    contentOffset: quoteLen + match[0].length,
  }
}

const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false })

/**
 * 回车：
 *   · 纯空的引用行（`> `）按一次回车就剥一层引用，单层直接清空退出引用；
 *   · 顶格的普通正文行（无引用、无缩进、非列表行）不交给 continueMarkup，防止上一行是列表时
 *     被当成懒续行塞进缩进空格；
 *   · 其余列表与引用续行交给语言包官方命令。
 */
function handleEnter(view: EditorView): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)

  if (/^[ \t]*(?:>[ \t]*)+$/.test(line.text)) {
    const lastGt = line.text.lastIndexOf('>')
    if (range.head >= line.from + lastGt + 1) {
      const depth = countQuotes(line.text)
      const delFrom = depth <= 1
        ? line.from
        : line.from + line.text.slice(0, lastGt).replace(/[ \t]+$/, '').length
      view.dispatch({
        changes: { from: delFrom, to: line.to, insert: '' },
        selection: { anchor: delFrom },
        scrollIntoView: true,
        userEvent: 'input',
      })
      return true
    }
  }

  if (!QUOTE_PREFIX_RE.test(line.text) && !parseListLine(line.text) && !/^[ \t]/.test(line.text)) {
    return false
  }

  return continueMarkup(view)
}

/**
 * 任务框后面那一格退格：只拆 `[ ] `，把列表标记（以及外层引用前缀）留着。
 *
 * 任务框是原子区间（左右键一次跨过整个 `- [ ] `）。CodeMirror 默认的退格会按原子区间
 * 整段删掉，一次就把 `- ` 也带走，落成光秃秃一行 `甲`。参照 Obsidian：先拆框，再拆标记，
 * 最后才轮到粘行。
 */
function deleteTaskBox(view: EditorView): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  const self = parseListLine(line.text)
  if (!self || !self.box) return false
  const contentStart = line.from + self.contentOffset
  if (range.head !== contentStart) return false

  const boxStart = contentStart - self.box.length
  view.dispatch({
    changes: { from: boxStart, to: contentStart, insert: '' },
    selection: { anchor: boxStart },
    userEvent: 'delete',
  })
  return true
}

/**
 * 行首与紧贴标记之后的退格：先拆这一行的结构，最后才并到上一行（design.md）。
 *
 *   缩进列表项 → 退一级缩进（不把标记换成一串空格）；
 *   一级列表项 → 去掉列表标记（在引用里则保留 `> `）；
 *   标题 `#`   → 变回段落；
 *   引用 `>`   → 剥掉一层引用。
 *
 * 渲染模式下 `#`、`-` 和前导空格都被藏起来了，Home 或鼠标点行首落在正文第一个字前，
 * 所以「紧贴标记之后」与 `line.from` 一视同仁。之前把列表标记后的位置漏给了语言包的
 * deleteMarkupBackward，后者把 `- ` 替换成空格，二级列表退一下就留下四个空格。
 */
function deleteAtLineStart(view: EditorView): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)

  const self = parseListLine(line.text)
  if (self && range.head <= line.from + self.contentOffset) {
    if (self.lead > 0) return indentListItem(view, -1)
    const from = line.from + self.quoteLen
    const to = line.from + self.contentOffset
    view.dispatch({
      changes: { from, to, insert: '' },
      selection: { anchor: from },
      userEvent: 'delete',
    })
    return true
  }

  const quotePrefix = QUOTE_PREFIX_RE.exec(line.text)?.[0] ?? ''
  const quoteLen = quotePrefix.length
  const head = /^#{1,6}[ \t]?/.exec(line.text.slice(quoteLen))
  if (head && head[0].length > 0 && range.head >= line.from + quoteLen && range.head <= line.from + quoteLen + head[0].length) {
    const from = line.from + quoteLen
    view.dispatch({
      changes: { from, to: from + head[0].length, insert: '' },
      selection: { anchor: from },
      userEvent: 'delete',
    })
    return true
  }

  if (quoteLen > 0 && range.head <= line.from + quoteLen) {
    // 多层引用一次剥最内层一个 `> `；单层引用若整行还有内容或光标在标记之后则拆掉 `> `
    if (line.text.length > quoteLen || range.head > line.from) {
      const innerMatch = /[ \t]*> ?$/.exec(quotePrefix)
      const delFrom = innerMatch ? line.from + quoteLen - innerMatch[0].length : line.from
      view.dispatch({
        changes: { from: delFrom, to: line.from + quoteLen, insert: '' },
        selection: { anchor: delFrom },
        userEvent: 'delete',
      })
      return true
    }
  }

  return false
}

/**
 * Tab / Shift+Tab：
 *   · 列表行（含引用里的列表）：在引用前缀之后把这一行缩进一级 / 退一级；
 *   · 引用里的普通行：在 `> ` 之后增减缩进，绝不让默认 indentWithTab 跑到 `>` 左边插空格
 *     （`>` 左边满 4 个空格会把引用块打碎成缩进代码块）。
 */
function indentListItem(view: EditorView, direction: 1 | -1): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  const self = parseListLine(line.text)

  if (!self) {
    const quotePrefix = QUOTE_PREFIX_RE.exec(line.text)?.[0]
    if (!quotePrefix) return false
    const bodyFrom = line.from + quotePrefix.length
    if (direction === 1) {
      const at = Math.max(range.head, bodyFrom)
      view.dispatch({
        changes: { from: at, to: at, insert: INDENT },
        selection: { anchor: at + INDENT.length },
        scrollIntoView: true,
        userEvent: 'input',
      })
      return true
    }
    const spaces = /^[ \t]+/.exec(line.text.slice(quotePrefix.length))?.[0] ?? ''
    if (!spaces) return true
    const remove = Math.min(spaces.length, INDENT.length)
    view.dispatch({
      changes: { from: bodyFrom, to: bodyFrom + remove, insert: '' },
      selection: { anchor: Math.max(bodyFrom, range.head - remove) },
      scrollIntoView: true,
      userEvent: 'input',
    })
    return true
  }

  const bodyFrom = line.from + self.quoteLen

  if (direction === 1) {
    const parent = parentItem(state, line, self.lead, self.quoteDepth)
    const target = parent ? parent.lead + parent.width : self.lead + self.width
    const lead = Math.max(target, self.lead + INDENT.length)
    const change = freshSublist(state, line, lead, self)
      ? { from: bodyFrom, to: bodyFrom + self.lead + self.digits.length, insert: `${' '.repeat(lead)}1` }
      : { from: bodyFrom, insert: ' '.repeat(lead - self.lead) }
    const changes = state.changes(change)
    view.dispatch({
      changes,
      selection: { anchor: changes.mapPos(range.head, 1) },
      scrollIntoView: true,
      userEvent: 'input',
    })
    return true
  }

  const parent = parentItem(state, line, self.lead - 1, self.quoteDepth)
  const lead = parent ? parent.lead : 0
  if (lead >= self.lead) return false
  view.dispatch({
    changes: { from: bodyFrom, to: bodyFrom + self.lead, insert: ' '.repeat(lead) },
    selection: { anchor: Math.max(bodyFrom + lead, range.head - (self.lead - lead)) },
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

/** 缩进成一条新的子列表时，序号从 1 起。只在同一引用层内向上看。 */
function freshSublist(
  state: EditorState,
  line: { text: string; number: number },
  depth: number,
  self: ParsedListLine,
): boolean {
  if (!self.digits) return false

  for (let number = line.number - 1; number >= 1; number--) {
    const prev = state.doc.line(number)
    const prevQuote = QUOTE_PREFIX_RE.exec(prev.text)?.[0] ?? ''
    if (countQuotes(prevQuote) !== self.quoteDepth) break
    const rest = prev.text.slice(prevQuote.length)
    if (rest.trim() === '') break
    const prevLine = parseListLine(prev.text)
    if (!prevLine) {
      if (/^[ \t]*/.exec(rest)![0].length > depth) continue
      break
    }
    if (prevLine.lead === depth) return false
    if (prevLine.lead < depth) break
  }

  return true
}

/** 往上找同一引用层里这一行的父项：第一条不比自己深的列表行。 */
function parentItem(
  state: EditorState,
  line: { number: number },
  lead: number,
  quoteDepth: number,
): { lead: number; width: number } | null {
  for (let number = line.number - 1; number >= 1; number--) {
    const prev = state.doc.line(number)
    const prevQuote = QUOTE_PREFIX_RE.exec(prev.text)?.[0] ?? ''
    if (countQuotes(prevQuote) !== quoteDepth) return null
    const rest = prev.text.slice(prevQuote.length)
    if (rest.trim() === '') return null
    const prevLine = parseListLine(prev.text)
    if (prevLine) {
      if (prevLine.lead <= lead) return prevLine
      continue
    }
    if (/^[ \t]*/.exec(rest)![0].length <= lead) return null
  }
  return null
}

export const listInput: Extension = Prec.high(keymap.of([
  { key: 'Enter', run: handleEnter },
  { key: 'Backspace', run: deleteTaskBox },
  { key: 'Backspace', run: deleteAtLineStart },
  { key: 'Backspace', run: deleteMarkupBackward },
  { key: 'Tab', run: (view) => indentListItem(view, 1) },
  { key: 'Shift-Tab', run: (view) => indentListItem(view, -1) },
]))
