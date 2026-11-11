// 列表与引用的输入手感。
//
// markdown 是纯文本，`- 文案` 就是一个减号加一段文字，渲染层只负责把它画成圆点。
// 但「回车自动续下一条」「在标记后面退格」是编辑器该做的事，跟渲染无关。
//
// 这两件事**不自己写**（2026-11-07 橘子：「不要自己写交互了啊，能不能参考下好的产品」）：
// CodeMirror 的 markdown 语言包自带一对命令，退回它俩。
//
//   insertNewlineContinueMarkup  回车：续上 `- `/`1. `/`> ` 的标记；空条目上回车就退出列表
//                                （官方默认会「在空条目上方插一个空行」，Obsidian 与
//                                Typora 都是直接退出列表，所以 nonTightLists 关掉）
//   deleteMarkupBackward         退格：光标紧贴标记时，先删标记/缩进，而不是把两行粘起来
//
// 以前自己写的那个版本，在列表行行首按退格会把上一行和这一行粘成 `- 乙- 丙`，
// 再退一次变成 `- - 丙`（渲染成嵌套圆点）：文件被改坏了，看着就是「列表格式丢了」。
//
import { EditorView, keymap } from '@codemirror/view'
import { Prec, type EditorState, type Extension } from '@codemirror/state'
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown'

/**
 * 列表行：缩进 + 标记 + 空白 + 可选的任务框。
 * 分组：1 缩进、2 无序标记、3 有序号、4 序号后缀、5 标记后的空白、6 任务框。
 */
const LIST_RE = /^([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/

/**
 * 行首退格：先拆标记，别把两行粘起来。
 *
 * 光标停在行首（标记之前）时，CodeMirror 默认的退格是把上一行和这一行接起来，
 * 于是 `- 乙` + `- 丙` 粘成 `- 乙- 丙`，再退一次变成 `- - 丙`，渲染成嵌套圆点：
 * 文件被改坏，看起来就是「列表格式丢了」（2026-11-07 报的）。
 *
 * 参照 Obsidian 与 Typora：行首退格先拆这一行的结构，拆到没结构了才并到上一行。
 *   缩进列表项 → 退一级；列表标记 → 去掉标记变成普通段落；
 *   标题 `#` → 变回段落；引用 `>` → 少一层引用。
 *
 * 这里只接「光标在行首」这一种情况；光标贴着标记之后的那种，交给语言包自带的
 * deleteMarkupBackward（见下面的 keymap）。
 */
function deleteAtLineStart(view: EditorView): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  if (range.head !== line.from) {
    // 列表行：光标贴着标记之后的那种情况交给语言包（它会把标记换成空格）
    if (!/^#{1,6}[ \t]?/.test(line.text) && !/^>[ \t]?/.test(line.text)) return false
  }

  const self = listLine(line.text)
  if (self) {
    if (self.lead > 0) return indentListItem(view, -1)
    const match = LIST_RE.exec(line.text)!
    const marker = match[0].length
    view.dispatch({
      changes: { from: line.from, to: line.from + marker, insert: '' },
      selection: { anchor: line.from },
      userEvent: 'delete',
    })
    return true
  }

  // 标题的 `#` 在渲染模式下是藏起来的，光标到不了真正的行首（Home 只能落在正文
  // 第一个字前），所以「光标紧贴标记之后」也算行首：一次退格就把整个标记拆掉，
  // 而不是先吃掉那个空格、留下 `#标题` 这种半截状态。
  const head = /^#{1,6}[ \t]?/.exec(line.text)
  if (head && head[0].length > 0 && range.head <= line.from + head[0].length) {
    view.dispatch({
      changes: { from: line.from, to: line.from + head[0].length, insert: '' },
      selection: { anchor: line.from },
      userEvent: 'delete',
    })
    return true
  }

  const quote = /^>[ \t]?/.exec(line.text)
  if (quote && line.text.length > quote[0].length && range.head <= line.from + quote[0].length) {
    view.dispatch({
      changes: { from: line.from, to: line.from + quote[0].length, insert: '' },
      selection: { anchor: line.from },
      userEvent: 'delete',
    })
    return true
  }

  return false
}

/**
 * 任务框后面那一格退格：只拆 `[ ] `，把列表标记留着。
 *
 * 任务框是原子区间（左右键一次跨过整个 `- [ ] `）。CodeMirror 默认的退格会按原子区间
 * 整段删掉，一次就把 `- ` 也带走，落成光秃儿一行 `甲`。用户看到的是「退格一下列表就没了」
 * （2026-11-11）：「删行，各种乱跳」。参照 Obsidian：先拆框，再拆标记，最后才轮到粘行。
 */
function deleteTaskBox(view: EditorView): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  const match = LIST_RE.exec(line.text)
  const box = match?.[6]
  if (!match || !box) return false
  const contentStart = line.from + match[0].length
  if (range.head !== contentStart) return false

  const boxStart = contentStart - box.length
  view.dispatch({
    changes: { from: boxStart, to: contentStart, insert: '' },
    selection: { anchor: boxStart },
    userEvent: 'delete',
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
    const changes = state.changes(change)
    view.dispatch({
      changes,
      // 新子列表会把多位序号改成 1，光标要按整笔替换映射，不能只加缩进宽度。
      selection: { anchor: changes.mapPos(range.head, 1) },
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

// Prec.high 不是装饰：state.ts 里的 defaultKeymap 也绑了 Enter 和 Backspace，而它在扩展表
// 里排在前面。同一个 keymap facet 里先出现的先试，所以不加优先级的话，Enter 永远先被
// defaultKeymap 的 insertNewlineAndIndent 接走，Backspace 也永远先被 deleteCharBackward
// 接走（粘连两行），上面这两条一行都不会跑。
export const listInput: Extension = Prec.high(keymap.of([
  { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
  // 顺序有讲究：任务框后面那一格先归 deleteTaskBox，不然 deleteMarkupBackward
  // 会按原子区间把 `- [ ] ` 整段吞掉。
  { key: 'Backspace', run: deleteTaskBox },
  { key: 'Backspace', run: deleteAtLineStart },
  { key: 'Backspace', run: deleteMarkupBackward },
  { key: 'Tab', run: (view) => indentListItem(view, 1) },
  { key: 'Shift-Tab', run: (view) => indentListItem(view, -1) },
]))
