// 列表的输入手感。
//
// markdown 是纯文本，`- 文案` 就是一个减号加一段文字，渲染层只负责把它画成圆点。
// 但「回车自动续下一条」是编辑器该做的事，跟渲染无关，所以放在这里：
// 一个 Enter 的 keymap，命中列表就在新行补上同样的标记。
//
// 一个刻意的限制：**只在光标位于行尾时接管**。光标在行中间按回车，用户是在断句，
// 不是在开新的一条，这时候插标记就是自作聪明。

import { EditorView, keymap } from '@codemirror/view'
import { Prec, type Extension } from '@codemirror/state'

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
 */
function indentListItem(view: EditorView, direction: 1 | -1): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  if (!LIST_RE.test(line.text)) return false

  if (direction === 1) {
    view.dispatch({
      changes: { from: line.from, insert: INDENT },
      selection: { anchor: range.head + INDENT.length },
      scrollIntoView: true,
    })
    return true
  }

  const leading = /^[ \t]+/.exec(line.text)
  if (!leading) return false
  const width = Math.min(leading[0].length, INDENT.length)
  view.dispatch({
    changes: { from: line.from, to: line.from + width, insert: '' },
    selection: { anchor: Math.max(line.from, range.head - width) },
    scrollIntoView: true,
  })
  return true
}

// Prec.high 不是装饰：state.ts 里的 defaultKeymap 也绑了 Enter，而它在扩展表里排在前面。
// 同一个 keymap facet 里先出现的先试，所以不加优先级的话，Enter 永远先被
// defaultKeymap 的 insertNewlineAndIndent 接走，下面这段代码一行都不会跑。
export const listInput: Extension = Prec.high(keymap.of([
  { key: 'Enter', run: continueList },
  { key: 'Tab', run: (view) => indentListItem(view, 1) },
  { key: 'Shift-Tab', run: (view) => indentListItem(view, -1) },
]))
