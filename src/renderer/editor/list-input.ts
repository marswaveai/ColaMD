// 列表的输入手感。
//
// markdown 是纯文本，`- 文案` 就是一个减号加一段文字，渲染层只负责把它画成圆点。
// 但「回车自动续下一条」是编辑器该做的事，跟渲染无关，所以放在这里：
// 一个 Enter 的 keymap，命中列表就在新行补上同样的标记。
//
// 一个刻意的限制：**只在光标位于行尾时接管**。光标在行中间按回车，用户是在断句，
// 不是在开新的一条，这时候插标记就是自作聪明。

import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { EditorView, keymap } from '@codemirror/view'
import { Prec, type EditorState, type Extension } from '@codemirror/state'

/**
 * 列表行：缩进 + 标记 + 空白 + 可选的任务框。
 * 分组：1 缩进、2 无序标记、3 有序号、4 序号后缀、5 标记后的空白、6 任务框。
 */
const LIST_RE = /^([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/

function continueList(view: EditorView): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  if (range.head !== line.to) return false

  const match = LIST_RE.exec(line.text)
  if (!match) return false

  const [, indent, bullet, number, delimiter, spacing, task] = match
  const content = line.text.slice(match[0].length)

  // 空条目上回车：结束列表。清掉标记，让这一行变成普通空行。
  // （这也是 Obsidian 与 Typora 的行为：再按一次回车就退出列表。）
  if (content.trim() === '') {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: '' },
      selection: { anchor: line.from },
      scrollIntoView: true,
      userEvent: 'input',
    })
    return true
  }

  // 无序列表沿用同一个标记，有序列表序号加一
  const marker = bullet ?? `${Number(number) + 1}${delimiter}`
  // 任务项续一个未勾选的框：连续记待办是常见写法
  const insert = `\n${indent}${marker}${spacing}${task ? '[ ] ' : ''}`
  view.dispatch({
    changes: { from: range.head, insert },
    selection: { anchor: range.head + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

/** 一级缩进的宽度。两个空格：`- ` 正好是两个字符，也和我们文档里的写法一致。 */
const INDENT = '  '

/**
 * Tab / Shift+Tab：把**这一行**缩进一级 / 退一级。
 *
 * 只在列表行上接管。不在列表行上就返回 false，让 state.ts 里绑的 indentWithTab 去插空格，
 * 那是它在行内的正常行为。整行缩进而不是在光标处插入空格：markdown 里列表的层级是由
 * **行首**的空格数决定的，在行中间插空格只会把文字挤歪。
 *
 * 缩进的宽度必须是**上一项的正文列**，不能统一给两个空格：markdown 要缩到父项内容列
 * 才算子列表，`- ` 是两列、`1. ` 是三列。以前不分宽度一律插两个空格，有序列表因此
 * 根本没嵌套，只是看起来往右挪了一点（2026-10-25 报的：「缩进后数到 3、4 而不是 1」）。
 */
function indentListItem(view: EditorView, direction: 1 | -1): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  const self = listLine(line.text)
  if (!self) return false

  if (direction === 1) {
    // 上一项：往上找第一条不比自己深的列表行，中间更深的内容算它的子项，跳过
    const parent = parentItem(state, line, self.lead)
    const target = parent ? parent.lead + parent.width : self.lead + self.width
    const lead = Math.max(target, self.lead + INDENT.length)
    // 缩进和改序号必须合成**一笔**改动：两笔的起点都是 line.from，CodeMirror 会把它们
    // 当重叠处理，序号那半会默默丢掉（实测：只插了空格，数字还是 6）。
    const change = freshSublist(state, line, lead)
      ? { from: line.from, to: line.from + self.lead + self.digits.length, insert: `${' '.repeat(lead)}1` }
      : { from: line.from, insert: ' '.repeat(lead - self.lead) }
    view.dispatch({
      changes: change,
      selection: { anchor: range.head + (lead - self.lead) },
      scrollIntoView: true,
      userEvent: 'input',
    })
    return true
  }

  const parent = parentItem(state, line, self.lead - 1)
  const lead = parent ? parent.lead : 0
  if (lead >= self.lead) return false
  view.dispatch({
    changes: { from: line.from, to: line.from + self.lead, insert: ' '.repeat(lead) },
    selection: { anchor: Math.max(line.from + lead, range.head - (self.lead - lead)) },
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

/**
 * 缩进成一条**新的**子列表时，序号从 1 起。
 *
 * markdown 里每一层列表各算各的起编号，Typora、Obsidian 都一样。搬着原来的数下去，
 * 屏幕上会接在父级后面数（1. 2. 3. 然后突然接 3. 4.），看着像还在同一层。
 * 判断标准是「新层上面有没有同级列表项」：有就接着数，没有就是从 1 开始的新列表。
 */
function freshSublist(
  state: EditorState,
  line: { text: string; number: number },
  depth: number,
): boolean {
  const self = listLine(line.text)
  if (!self || !self.digits) return false

  for (let number = line.number - 1; number >= 1; number--) {
    const prev = state.doc.line(number)
    if (prev.text.trim() === '') break
    const prevLine = listLine(prev.text)
    if (!prevLine) {
      // 更深的续行属于上一个列表项，继续往上找；不比目标层级深的说明这一块结束了
      if (/^[ \t]*/.exec(prev.text)![0].length > depth) continue
      break
    }
    if (prevLine.lead === depth) return false
    if (prevLine.lead < depth) break
  }

  return true
}

/** 列表行的三样东西：缩进宽度、标记宽度（含后面的空白）、有序项的序号原文。 */
function listLine(text: string): { lead: number; width: number; digits: string } | null {
  const match = LIST_RE.exec(text)
  if (!match) return null
  const lead = match[1].length
  // 任务框不算标记：内容从框后面开始，子列表也要缩到那一列
  const width = match[0].length - lead - (match[6]?.length ?? 0)
  return { lead, width, digits: match[3] ?? '' }
}

/**
 * 往上找这一行的父项：第一条不比自己深的列表行。
 *
 * 中间那些更深的行是上一项的子内容（续行、子列表），不是父项；碰到空行或更浅
 * 的普通段落就当没有父项。
 */
function parentItem(
  state: EditorState,
  line: { number: number },
  lead: number,
): { lead: number; width: number } | null {
  for (let number = line.number - 1; number >= 1; number--) {
    const prev = state.doc.line(number)
    if (prev.text.trim() === '') return null
    const prevLine = listLine(prev.text)
    if (prevLine) {
      if (prevLine.lead <= lead) return prevLine
      continue
    }
    if (/^[ \t]*/.exec(prev.text)![0].length <= lead) return null
  }
  return null
}

// Prec.high 不是装饰：state.ts 里的 defaultKeymap 也绑了 Enter，而它在扩展表里排在前面。
// 同一个 keymap facet 里先出现的先试，所以不加优先级的话，Enter 永远先被
// defaultKeymap 的 insertNewlineAndIndent 接走，下面这段代码一行都不会跑。
export const listInput: Extension = Prec.high(keymap.of([
  { key: 'Enter', run: view => {
    const { state } = view
    const line = state.doc.lineAt(state.selection.main.head)
    if (!/^[ \t]*>/.test(line.text)) return false
    // 只在语法归属确为引用时续标记，围栏代码里的 `>` 是普通字符。
    let node = syntaxTree(state).resolveInner(Math.min(line.to, line.from + line.text.indexOf('>') + 1), 1)
    while (node && node.name !== 'Blockquote') node = node.parent!
    return !!node && insertNewlineContinueMarkup(view)
  } },
  { key: 'Enter', run: continueList },
  { key: 'Tab', run: (view) => indentListItem(view, 1) },
  { key: 'Shift-Tab', run: (view) => indentListItem(view, -1) },
]))
