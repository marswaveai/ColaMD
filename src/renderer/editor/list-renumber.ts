// 有序列表的序号：跟着编辑走，写回文件。
//
// markdown 里只有列表**第一项**的数字有用（CommonMark 拿它当 `<ol start>`），后面的数字
// 谁渲染谁重排。但**文件里的数就是屏幕上的数**：只改渲染的话，屏幕上 1、2、3，复制出去
// 还是 1、3、4，在 Obsidian 里打开也是 1、3、4，这就把「文件是唯一真相」卖掉了
// （2026-10-06 定的）。所以增删列表项时，把序号按顺序写回去，序号和正文一起进撤销栈。
//
// 什么时候动手，两条：
//   · 列表项的数量变了：删掉一项、回车加一项、Tab 改层级、粘贴一整段
//   · 改动碰到了序号本身：改起始编号
//
// 只改文字不动序号。有人在列表里敲字，不该把 `1. 1. 1.` 那种写法（为了 diff 干净）
// 抹平成 1、2、3，Typora 这么干还被人专门开 issue 骂过（typora-issues#1188）。
// 打开文件、外部写入、导出这些程序化改动一概不碰，「用户没碰过的字节不许变」照旧。
//
// 为什么要自己解析一遍：State 的语法树是按视口惰性推进的，刚改完那一块不保证已经解析
// （装饰层的 parseRefresh 就是为这个存在）。这里只切出改动所在的一段来解析，
// 段小、便宜，也不用猜整篇的状态。

import { ChangeSet, EditorState, Transaction, type Text } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode, Tree } from '@lezer/common'
import { markdownParser } from './state'

/** 引用前缀：每层 `>` 最多吃掉紧跟的一个空格，其余空白算块内缩进。 */
const QUOTE_PREFIX_RE = /^(?:[ \t]*> ?)+/
/** 列表项那一行（允许套在引用里）：缩进 + `-`/`*`/`+` 或 `1.`/`1)` + 空白。 */
const LIST_LINE = /^(?:[ \t]*> ?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]/
/** 缩进着的内容：可能是列表项的续行，也可能是嵌套列表。 */
const INDENTED = /^(?:[ \t]*> ?)*[ \t]/
/** 往后扫的上限，防止在没有空行的大文档里一路扫到底。 */
const MAX_SCAN_LINES = 5000

interface Mark {
  from: number
  to: number
}

interface ListInfo {
  from: number
  to: number
  /** 同一个 OrderedList 节点里，被上方顶格普通正文（懒续行）劈出来的下半截。 */
  splitFromAbove: boolean
  /** 每项 ListMark（`1.` 那两个字符）的位置，相对传进来那一段的起点。 */
  marks: Mark[]
}

/**
 * 一次用户编辑之后，把受影响的列表序号排一遍。
 *
 * 排在同一次更新里（返回 `[tr, 补丁]`），所以撤销一次就回到编辑前，不会留下
 * 一个「撤销了删除、序号却没回去」的中间态。
 */
/** 防重入：补丁那一笔事务会再过一遍这个过滤器，不能让它无限套娃。 */
let patching = false

export const renumberLists = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr
  const event = tr.annotation(Transaction.userEvent)
  // 只认用户自己动手的改动。撤销/重做也放过：那时候要还原的是历史，不是重排。
  if (!event || event.startsWith('undo') || event.startsWith('redo')) return tr

  const before = syntaxTree(tr.startState)
  if (!touchesOrderedList(before, tr.changes)) return tr

  const { oldRange, newRange } = affectedRanges(tr, before)
  const beforeSlice = tr.startState.doc.sliceString(oldRange.from, oldRange.to)
  const oldLists = orderedLists(markdownParser.parse(beforeSlice), beforeSlice)
  const slice = tr.newDoc.sliceString(newRange.from, newRange.to)
  const changes: { from: number; to: number; insert: string }[] = []

  for (const list of orderedLists(markdownParser.parse(slice), slice)) {
    const plan = renumberPlan(list, oldLists, tr.changes, newRange.from, oldRange.from)
    if (!plan.run) continue
    const start = plan.resetToOne
      ? 1
      : Number.parseInt(slice.slice(list.marks[0].from, list.marks[0].to), 10)
    if (!Number.isFinite(start)) continue
    list.marks.forEach((mark, index) => {
      const now = slice.slice(mark.from, mark.to)
      const want = `${start + index}${now.endsWith(')') ? ')' : '.'}`
      if (now !== want) changes.push({ from: newRange.from + mark.from, to: newRange.from + mark.to, insert: want })
    })
  }

  if (changes.length === 0) return tr
  if (patching) return tr

  // 补丁必须和用户那一笔改动**合成一笔**，理由有两条，都是实测撞出来的：
  //   · 返回 `[tr, { changes }]` 不行。过滤器返回数组时，CodeMirror 把两段规格都按
  //     `tr.startState` 的坐标解析并合并（state 包 resolveTransaction 的 `state` 就是
  //     startState），于是删掉的行会让补丁整体错位：`1. 甲 / 3. 乙 / 4. 丙` 删掉中间那项，
  //     落成了 `2.3. 丙`。
  //   · 返回一笔从 `tr.state` 出发的事务也不行。那样文档确实对，但视图会拒收：
  //     `Trying to update state with a transaction that doesn't start from the previous
  //     state`——视图要求每一笔事务都从它当前的状态出发。
  // 所以这里把补丁按新文档算好，用 `compose` 接到用户那笔改动后面，交回一笔从
  // `tr.startState` 出发的事务：文档对，视图认，撤销一步回到改前。
  const patch = ChangeSet.of(changes, tr.newDoc.length)
  patching = true
  try {
    return tr.startState.update({
      changes: tr.changes.compose(patch),
      selection: tr.selection ? tr.selection.map(patch) : undefined,
      effects: tr.effects,
      // `Transaction.annotations` 不是公开字段，这里只把 userEvent 传下去：
      // 撤销分组和「这是一次编辑」的语义都靠它
      userEvent: event,
      scrollIntoView: tr.scrollIntoView,
    })
  } finally {
    patching = false
  }
})

/**
 * 树里的有序列表，各取自己每项 ListMark 的位置。
 *
 * 两处边界与渲染层对齐：
 *   1. 孤立的 `1.`（后面还没敲空格）不算成型的列表项，避免用户打 `1.5` 或刚敲到句点
 *      就被重排成上一列表的续号。
 *   2. 某一项后面若紧跟顶格非空正文（CommonMark 算作懒续行，但用户其实是退出列表后写正文），
 *      列表在该项结束，后面再敲 `1. ` 独立从头编号，不跨过正文续成 `5. `。
 */
function itemHasLazyBreak(item: SyntaxNode, slice: string): boolean {
  let ownEnd = item.to
  for (let child = item.firstChild; child; child = child.nextSibling) {
    if (child.name === 'BulletList' || child.name === 'OrderedList') {
      ownEnd = child.from
      break
    }
  }
  const lines = slice.slice(item.from, ownEnd).split('\n')
  for (let i = 1; i < lines.length; i++) {
    const body = lines[i].replace(QUOTE_PREFIX_RE, '')
    if (body.trim() !== '' && !/^[ \t]/.test(body)) return true
  }
  return false
}

function orderedLists(tree: Tree, slice: string): ListInfo[] {
  const lists: ListInfo[] = []
  tree.iterate({
    enter(node) {
      if (node.name !== 'OrderedList') return
      let marks: Mark[] = []
      let segFrom = node.from
      let segTo = node.from
      let splitFromAbove = false
      const flush = (nextSplit: boolean): void => {
        if (marks.length > 0) lists.push({ from: segFrom, to: segTo, splitFromAbove, marks })
        marks = []
        if (nextSplit) splitFromAbove = true
      }
      for (let item = node.node.firstChild; item; item = item.nextSibling) {
        if (item.name !== 'ListItem') continue
        const mark = item.getChild('ListMark')
        if (!mark) continue
        const after = slice[mark.to]
        if (after !== ' ' && after !== '\t') continue
        if (marks.length === 0) segFrom = item.from
        marks.push({ from: mark.from, to: mark.to })
        segTo = item.to
        if (itemHasLazyBreak(item, slice)) flush(true)
      }
      flush(false)
    },
  })
  return lists
}

/** 改动有没有落到有序列表上。只看改动前那棵树：够准，而且不用解析。 */
function touchesOrderedList(tree: Tree, changes: ChangeSet): boolean {
  let hit = false
  changes.iterChangedRanges((fromA, toA) => {
    if (hit) return
    const last = Math.max(fromA, toA - 1)
    for (const [pos, side] of [[fromA, -1], [fromA, 1], [last, -1], [last, 1]] as const) {
      if (enclosingOrderedList(tree, pos, side)) {
        hit = true
        return
      }
    }
  })
  return hit
}

function enclosingOrderedList(tree: Tree, pos: number, side: -1 | 1): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(Math.min(Math.max(pos, 0), tree.length), side)
  while (node) {
    if (node.name === 'OrderedList') return node
    node = node.parent
  }
  return null
}

/**
 * 要去重排的那段文本。
 *
 * 起点取改动所在**最外层块**的第一行：列表的边界就在这一层，从块的边界切，
 * 不会把一个列表从中间切断。终点往后扫到列表确定结束为止（见 listClusterEnd）。
 */
function affectedRanges(
  tr: Transaction,
  before: Tree,
): { oldRange: { from: number; to: number }; newRange: { from: number; to: number } } {
  let first = -1
  tr.changes.iterChangedRanges((fromA) => {
    if (first < 0) first = fromA
  })
  if (first < 0) {
    return {
      oldRange: { from: 0, to: tr.startState.doc.length },
      newRange: { from: 0, to: tr.newDoc.length },
    }
  }

  let block: SyntaxNode | null = before.resolveInner(first, 1)
  while (block && block.parent && block.parent.name !== 'Document') block = block.parent
  const oldBase = block ? block.from : first
  const oldFrom = tr.startState.doc.lineAt(Math.min(Math.max(oldBase, 0), tr.startState.doc.length)).from
  const oldTo = listClusterEnd(tr.startState.doc, oldFrom)

  const mapped = tr.changes.mapPos(oldBase, -1)
  const newFrom = tr.newDoc.lineAt(Math.min(Math.max(mapped, 0), tr.newDoc.length)).from
  const newTo = listClusterEnd(tr.newDoc, newFrom)
  return {
    oldRange: { from: oldFrom, to: oldTo },
    newRange: { from: newFrom, to: newTo },
  }
}

/**
 * 列表往后铺到哪儿为止。
 *
 * 空行不是结束：松列表里空行是允许的（`1. 甲`、空行、`2. 乙` 仍是一个列表）。
 * 空行之后跟的第一行既不是列表项、也不是缩进内容，那个列表才算真的结束。
 * 宁可多切一点：多切只会多解析几行，少切会把列表从中间截断，序号就会排错。
 */
function listClusterEnd(doc: Text, from: number): number {
  const first = doc.lineAt(from)
  let end = first.to
  let blank = false
  const stop = Math.min(doc.lines, first.number + MAX_SCAN_LINES)
  for (let number = first.number + 1; number <= stop; number++) {
    const line = doc.line(number)
    const stripped = line.text.replace(QUOTE_PREFIX_RE, '')
    if (stripped.trim() === '') {
      blank = true
      end = line.to
      continue
    }
    if (blank && !LIST_LINE.test(line.text) && !INDENTED.test(line.text)) break
    blank = false
    end = line.to
  }
  return end
}

/**
 * 这个列表要不要重排，以及是否因为原列表刚从中间被普通段落劈开而要从 1 重新起算。
 *
 * 数量变了（增删项、改层级）要重排；改动碰到序号本身（改起始编号）也要。
 * 其它情况一律放过：在列表里打普通文字不该动序号。
 */
function renumberPlan(
  list: ListInfo,
  oldLists: ListInfo[],
  changes: ChangeSet,
  newOffset: number,
  oldOffset: number,
): { run: boolean; resetToOne: boolean } {
  const listNewFrom = newOffset + list.from
  const listNewTo = newOffset + list.to
  const old = oldLists.find((item) => {
    const mappedFrom = changes.mapPos(oldOffset + item.from, 1)
    const mappedTo = changes.mapPos(oldOffset + item.to, -1)
    return mappedTo >= listNewFrom && mappedFrom <= listNewTo
  })

  // 原来是一整张列表，中间某一项刚被拆成普通文字（如 `2. 乙` → `乙`），下半截从 1 重新编号。
  if (list.splitFromAbove && old) {
    const oldFirstMapped = changes.mapPos(oldOffset + old.marks[0].from, 1)
    if (oldFirstMapped < newOffset + list.marks[0].from) {
      return { run: true, resetToOne: true }
    }
  }

  let touchedThisSegment = false
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (toB >= listNewFrom - 1 && fromB <= listNewTo + 1) touchedThisSegment = true
  })
  if (!touchedThisSegment) return { run: false, resetToOne: false }

  if (!old) return { run: true, resetToOne: false }
  if (old.marks.length !== list.marks.length) return { run: true, resetToOne: false }
  return { run: touchedMark(changes, old, oldOffset), resetToOne: false }
}

/** 改动有没有碰到这个列表里某个序号。位置都是**改动前**的坐标。 */
function touchedMark(changes: ChangeSet, list: ListInfo, oldOffset: number): boolean {
  let hit = false
  changes.iterChangedRanges((fromA, toA) => {
    if (hit) return
    for (const raw of list.marks) {
      const markFrom = oldOffset + raw.from
      const markTo = oldOffset + raw.to
      if (fromA <= markFrom && toA >= markFrom) {
        hit = true
        return
      }
      if (fromA < markTo && toA > markFrom) {
        hit = true
        return
      }
    }
  })
  return hit
}
