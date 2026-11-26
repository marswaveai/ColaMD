// 列表与引用的输入手感。
//
// 有序列表的回车、退格、缩进、光标导航全部由 list-model.ts 驱动，
// 不再依赖 CodeMirror 默认的 insertNewlineContinueMarkupCommand（它会在松散列表多插空行、
// 把子列表过继给新同级项、把孤立空首项 `1. ` 直接吞掉）。
//
// 无序列表与引用保留既有手感：行中回车续标记、待办框后退格只拆框、空引用行一次回车退出、
// 缩进落在 `> ` 之后。

import { EditorView, keymap } from '@codemirror/view'
import { EditorSelection, EditorState, Prec, Transaction, type Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown'
import {
  BULLET_INDENT,
  ORDERED_INDENT,
  QUOTE_PREFIX_RE,
  adjustLeadEdit,
  countQuotes,
  expandIndent,
  findFirstDirectChild,
  findIndentParent,
  findOutdentTarget,
  findPrevSibling,
  frontmatterEnd,
  isActiveOrderedListLine,
  isExcludedLine,
  parseListLine,
  scanListBlock,
  type BlockItem,
  type ParsedListLine,
} from './list-model'

const BULLET_INDENT_STR = ' '.repeat(BULLET_INDENT)
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false })

function getTreeAndFm(state: EditorState) {
  return { tree: syntaxTree(state), fmEnd: frontmatterEnd(state.doc) }
}

/** 安全解析有序序号，保留合法的 `0.` 起点，绝不把 `0` 误转成 `1`。 */
function parseOrderDigits(digits: string): number {
  const n = Number.parseInt(digits, 10)
  return Number.isFinite(n) && n >= 0 ? n : 1
}

/**
 * 回车：
 *   · 围栏代码块 / HTML 块 / 表格 / 属性区里放行默认换行；
 *   · 纯空引用行（`> `）单次回车直接退出一层引用；
 *   · 有序列表项由自研状态机精准处理（孤立空首项保留并续 `2.`、非首空项退出、
 *     嵌套空项先退一级、带子列表父项行尾插首子项、绝不因松散多插空行）；
 *   · 无序列表与普通引用继续走成熟路径，顶格普通行不触发懒续行。
 */
function handleEnter(view: EditorView): boolean {
  const { state } = view
  if (state.selection.ranges.length > 1) return false
  const range = state.selection.main
  const { tree, fmEnd } = getTreeAndFm(state)

  const startLine = state.doc.lineAt(range.from)
  if (isExcludedLine(state.doc, tree, startLine.number, fmEnd)) return false

  // 有序列表项（含在单项内部有选区时，先删选区再续下一项）
  const startParsed = parseListLine(startLine.text)
  if (startParsed?.kind === 'ordered') {
    if (!range.empty) {
      const endLine = state.doc.lineAt(range.to)
      // 跨多行选区交给浏览器/CM 默认删选区换行（避免误把半张表合并续号）
      if (endLine.number !== startLine.number) return false
      return handleOrderedEnter(view, startLine, startParsed, range.from, range.to)
    }
    return handleOrderedEnter(view, startLine, startParsed, range.head, range.head)
  }

  if (!range.empty) return false

  // 纯空引用行：一次回车剥一层 `> `（多层引用保留外层 `> ` 后的单个空格）
  if (/^[ \t]*(?:>[ \t]*)+$/.test(startLine.text)) {
    const lastGt = startLine.text.lastIndexOf('>')
    if (range.head >= startLine.from + lastGt + 1) {
      const depth = countQuotes(startLine.text)
      if (depth <= 1) {
        view.dispatch({
          changes: { from: startLine.from, to: startLine.to, insert: '' },
          selection: { anchor: startLine.from },
          scrollIntoView: true,
          userEvent: 'input',
        })
      } else {
        const beforeLast = startLine.text.slice(0, lastGt).replace(/[ \t]+$/, '')
        const kept = `${beforeLast} `
        view.dispatch({
          changes: { from: startLine.from, to: startLine.to, insert: kept },
          selection: { anchor: startLine.from + kept.length },
          scrollIntoView: true,
          userEvent: 'input',
        })
      }
      return true
    }
  }

  // 非列表行不交给 continueMarkup：
  //   · 顶格或带缩进的普通行（含未带空格的 `1.`、`  1.`、`1.\t`）直接放行普通换行，
  //     防止被懒续行塞缩进，或被官方命令误当空列表项删空/续出 `2.`；
  //   · 普通引用行（含 `> 1.`、`> 1.\t甲`）手动续当前引用前缀，不触发伪列表续号。
  if (!startParsed) {
    const quotePrefix = QUOTE_PREFIX_RE.exec(startLine.text)?.[0]
    if (!quotePrefix) return false
    const insert = `\n${quotePrefix}`
    view.dispatch({
      changes: { from: range.head, to: range.head, insert },
      selection: { anchor: range.head + insert.length },
      scrollIntoView: true,
      userEvent: 'input',
    })
    return true
  }

  // 无序空列表项（含紧跟普通段落下方刚敲完 `- `、尚未被语法树拆出 BulletList 的空项）：
  // 嵌套空项先退一级，一级空项直接清空前缀退出列表。
  if (startParsed.kind === 'bullet' && startParsed.isEmpty && range.head >= startLine.from + startParsed.contentOffset) {
    if (startParsed.lead > 0) return indentSingleLine(view, startLine.number, -1)
    const delFrom = startLine.from + startParsed.quoteLen
    view.dispatch({
      changes: { from: delFrom, to: startLine.to, insert: '' },
      selection: { anchor: delFrom },
      scrollIntoView: true,
      userEvent: 'input',
    })
    return true
  }

  // 无序项正文首字前（`- |甲`）：与有序项 2b 一致，在上方插入完整的空同级项，光标留在原正文前。
  // 交给 continueMarkup 会先削掉光标前的空白，上一行只剩 `-`，渲染层不认它是列表（见 hasListSpace）。
  const bulletStart = startLine.from + startParsed.contentOffset
  if (startParsed.kind === 'bullet' && !startParsed.isEmpty && range.head <= bulletStart) {
    const indent = startLine.text.slice(startParsed.quoteLen, startParsed.quoteLen + startParsed.leadChars)
    const upper = `${startParsed.quotePrefix}${indent}${startParsed.bullet} ${startParsed.box ? '[ ] ' : ''}\n`
    const changes = state.changes({ from: startLine.from, to: startLine.from, insert: upper })
    view.dispatch({
      changes,
      selection: { anchor: changes.mapPos(bulletStart, 1) },
      scrollIntoView: true,
      userEvent: 'input',
    })
    return true
  }

  return continueMarkup(view)
}

function handleOrderedEnter(
  view: EditorView,
  line: { number: number; from: number; to: number; text: string },
  self: ParsedListLine,
  selFrom: number,
  selTo: number,
): boolean {
  const { state } = view
  const { tree, fmEnd } = getTreeAndFm(state)
  const contentStart = line.from + self.contentOffset
  const block = scanListBlock(state.doc, line.number, tree, fmEnd)

  // 1. 空项（选区为空且正文为空）
  if (selFrom === selTo && self.isEmpty) {
    // 1a. 嵌套空子项：先退一级缩进，不一步退光
    if (self.lead > 0) {
      return indentSingleLine(view, line.number, -1)
    }
    // 1b. 一级空项：判断上方有没有同级有序前驱
    const prevSib = block ? findPrevSibling(block, line.number) : null
    if (!prevSib) {
      // 孤立空首项（刚敲完 `1. `）：保留第一行并续出下一号（`2. `）
      const nextNum = parseOrderDigits(self.digits) + 1
      const nextPrefix = `${self.quotePrefix}${nextNum}${self.delim} ${self.box ? '[ ] ' : ''}`
      const insert = `\n${nextPrefix}`
      view.dispatch({
        changes: { from: line.to, to: line.to, insert },
        selection: { anchor: line.to + insert.length },
        scrollIntoView: true,
        userEvent: 'input',
      })
      return true
    }
    // 1c. 非首空项（如 `1. 甲\n2. ` 或 `1. \n2. `）：删除列表前缀退出列表（引用内保留 `> `）
    const delFrom = line.from + self.quoteLen
    view.dispatch({
      changes: { from: delFrom, to: line.to, insert: '' },
      selection: { anchor: delFrom },
      scrollIntoView: true,
      userEvent: 'input',
    })
    return true
  }

  // 2. 非空项：按光标位置决定切分方式
  // 如果用户仅选中了前缀部分（如手动选了 `"1. "`），放行默认删选区换行而非在上方插空项
  if (selFrom < selTo && selTo <= contentStart) return false

  const cutFrom = Math.max(selFrom, contentStart)
  const cutTo = Math.max(selTo, cutFrom)
  const after = line.text.slice(cutTo - line.from)
  const indentStr = line.text.slice(self.quoteLen, self.quoteLen + self.leadChars)
  const nextBox = self.box ? '[ ] ' : ''

  // 2a. 光标在行尾且下一行紧跟当前项的直接子列表：插入为该子列表的第一条子项
  // （中间夹着 Shift+Enter 软换行续行时不插在续行之上）
  if (after === '' && block) {
    const firstChild = findFirstDirectChild(block, line.number)
    if (firstChild && firstChild.lineNumber === line.number + 1) {
      const childLine = state.doc.line(firstChild.lineNumber)
      const childIndent = childLine.text.slice(
        firstChild.parsed.quoteLen,
        firstChild.parsed.quoteLen + firstChild.parsed.leadChars,
      )
      const childMarker = firstChild.parsed.kind === 'ordered'
        ? `1${firstChild.parsed.delim} `
        : `${firstChild.parsed.bullet} `
      const childBox = firstChild.parsed.box ? '[ ] ' : ''
      const insert = `\n${firstChild.parsed.quotePrefix}${childIndent}${childMarker}${childBox}`
      view.dispatch({
        changes: { from: cutFrom, to: cutTo, insert },
        selection: { anchor: cutFrom + insert.length },
        scrollIntoView: true,
        userEvent: 'input',
      })
      return true
    }
  }

  // 2b. 光标在正文首字前（`1. |甲`）：在上方插入空同级项，原项下移顺延，光标留在原正文前
  if (cutFrom === contentStart && cutTo === contentStart && after !== '') {
    const num = parseOrderDigits(self.digits)
    const upperLine = `${self.quotePrefix}${indentStr}${num}${self.delim} ${nextBox}\n`
    const changes = state.changes({ from: line.from, to: line.from, insert: upperLine })
    view.dispatch({
      changes,
      selection: { anchor: changes.mapPos(contentStart, 1) },
      scrollIntoView: true,
      userEvent: 'input',
    })
    return true
  }

  // 2c. 行中或行尾（无直接子列表）：单换行续下一项，绝不因松散列表多插空行
  const nextNum = parseOrderDigits(self.digits) + 1
  const nextPrefix = `${self.quotePrefix}${indentStr}${nextNum}${self.delim} ${nextBox}`
  const insert = `\n${nextPrefix}`
  view.dispatch({
    changes: { from: cutFrom, to: cutTo, insert },
    selection: { anchor: cutFrom + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

/** Shift+Enter：列表项内软换行续段，缩进对齐当前项正文，不新建序号。 */
function handleShiftEnter(view: EditorView): boolean {
  const { state } = view
  if (state.selection.ranges.length > 1) return false
  const range = state.selection.main
  const { tree, fmEnd } = getTreeAndFm(state)
  const line = state.doc.lineAt(range.from)
  if (isExcludedLine(state.doc, tree, line.number, fmEnd)) return false
  const self = parseListLine(line.text)
  if (!self) return false

  const pad = ' '.repeat(self.lead + self.markerWidth)
  const insert = `\n${self.quotePrefix}${pad}`
  const cutFrom = Math.max(range.from, line.from + self.contentOffset)
  const cutTo = Math.max(range.to, cutFrom)
  view.dispatch({
    changes: { from: cutFrom, to: cutTo, insert },
    selection: { anchor: cutFrom + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

/** 任务框后面那一格退格：只拆 `[ ] `，把列表标记和引用前缀留着。 */
function deleteTaskBox(view: EditorView): boolean {
  const { state } = view
  if (state.selection.ranges.length > 1) return false
  const range = state.selection.main
  if (!range.empty) return false
  const { tree, fmEnd } = getTreeAndFm(state)
  const line = state.doc.lineAt(range.head)
  if (isExcludedLine(state.doc, tree, line.number, fmEnd)) return false
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
 * 行首与紧贴标记之后的退格：
 *   · 有序列表：
 *       - 缩进子项 -> 整棵子树退一级缩进；
 *       - 一级第一项 -> 取消本行列表格式（下方项由重排器同事务归 1.，格式不丢）；
 *       - 一级非首项 -> 不拆成夹在中间的普通行，直接合并到上一行末尾（空项则删空行回到上行末）。
 *   · 无序列表 / 标题 `#` / 引用 `>`：保持既有逐级拆解手感。
 */
function deleteAtLineStart(view: EditorView): boolean {
  const { state } = view
  if (state.selection.ranges.length > 1) return false
  const range = state.selection.main
  if (!range.empty) return false
  const { tree, fmEnd } = getTreeAndFm(state)
  const line = state.doc.lineAt(range.head)
  if (isExcludedLine(state.doc, tree, line.number, fmEnd)) return false

  const self = parseListLine(line.text)
  if (self && range.head <= line.from + self.contentOffset) {
    if (self.lead > 0) return indentSingleLine(view, line.number, -1)

    if (self.kind === 'ordered') {
      const block = scanListBlock(state.doc, line.number, tree, fmEnd)
      const prevSib = block ? findPrevSibling(block, line.number) : null
      if (prevSib && line.number > 1) {
        // 非首项：直接合并到上一行末尾，绝不往列表中间硬塞普通行把表劈成两截
        const prevLine = state.doc.line(line.number - 1)
        const delFrom = prevLine.to
        const delTo = line.from + self.contentOffset
        view.dispatch({
          changes: { from: delFrom, to: delTo, insert: '' },
          selection: { anchor: delFrom },
          scrollIntoView: true,
          userEvent: 'delete',
        })
        return true
      }
      // 第一项：取消列表格式（引用内保留 `> `），下方项由 renumberLists 同事务归 1.
      const from = line.from + self.quoteLen
      const to = line.from + self.contentOffset
      view.dispatch({
        changes: { from, to, insert: '' },
        selection: { anchor: from },
        scrollIntoView: true,
        userEvent: 'delete',
      })
      return true
    }

    // 无序一级项：拆掉标记（保留引用前缀）
    const from = line.from + self.quoteLen
    const to = line.from + self.contentOffset
    view.dispatch({
      changes: { from, to, insert: '' },
      selection: { anchor: from },
      scrollIntoView: true,
      userEvent: 'delete',
    })
    return true
  }

  const quotePrefix = QUOTE_PREFIX_RE.exec(line.text)?.[0] ?? ''
  const quoteLen = quotePrefix.length
  const bodyFrom = line.from + quoteLen
  const body = line.text.slice(quoteLen)
  const leadRaw = /^[ \t]*/.exec(body)?.[0] ?? ''
  // 列表项下的缩进续行（渲染层已隐藏前导空白）：行首退格直接退回上一级对齐或顶格，
  // 避免逐个删看不见的空格导致退格像没反应。
  if (!self && body.trim() !== '' && leadRaw.length > 0 && range.head <= bodyFrom + leadRaw.length) {
    const cont = findContinuationAlign(state.doc, tree, fmEnd, line.number, countQuotes(quotePrefix))
    if (cont) {
      const curCols = expandIndent(leadRaw)
      const prevCols = [...cont.levels].reverse().find((c) => c < curCols) ?? 0
      const replacement = ' '.repeat(prevCols)
      view.dispatch({
        changes: { from: bodyFrom, to: bodyFrom + leadRaw.length, insert: replacement },
        selection: { anchor: bodyFrom + replacement.length },
        scrollIntoView: true,
        userEvent: 'delete',
      })
      return true
    }
  }

  const head = /^#{1,6}[ \t]?/.exec(body)
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
    if (line.text.length > quoteLen || range.head > line.from) {
      const innerMatch = />[ \t]?$/.exec(quotePrefix)
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
 *   · 单行列表项：按合法父项缩进/退缩进，整棵子树同步升降级；
 *     禁止列表首项缩进成代码块，最多比上一项深 1 级。
 *   · 多行选区含列表项：整批升降级选区内的列表行，不把选区删成 `\t`。
 *   · 引用内普通行：缩进落在 `> ` 之后，不把 `>` 推成代码块。
 */
function handleTab(view: EditorView, direction: 1 | -1): boolean {
  const { state } = view
  if (state.selection.ranges.length > 1) return false
  const range = state.selection.main
  const { tree, fmEnd } = getTreeAndFm(state)

  const startLine = state.doc.lineAt(range.from)
  const endPos = range.empty ? range.to : Math.max(range.from, range.to - (range.to > range.from && state.doc.lineAt(range.to).from === range.to ? 1 : 0))
  const endLine = state.doc.lineAt(endPos)

  if (startLine.number === endLine.number) {
    if (isExcludedLine(state.doc, tree, startLine.number, fmEnd)) return false
    return indentSingleLine(view, startLine.number, direction)
  }

  return indentMultiLineSelection(view, startLine.number, endLine.number, direction)
}

/**
 * 查紧贴在当前普通行上方的列表块，算出从顶格到最深列表项正文的逐级对齐列宽（如 `[0, 3, 7]`）。
 * 用于列表项下方插入普通行时，按 Tab 对齐上级列表正文、按 Shift+Tab 一次干净退回。
 */
function findContinuationAlign(
  doc: EditorState['doc'],
  tree: ReturnType<typeof syntaxTree>,
  fmEnd: number,
  lineNumber: number,
  quoteDepth: number,
): { levels: number[] } | null {
  if (lineNumber <= 1) return null
  const prevBlock = scanListBlock(doc, lineNumber - 1, tree, fmEnd)
  if (!prevBlock || prevBlock.quoteDepth !== quoteDepth || prevBlock.items.length === 0) return null
  const cols = new Set<number>([0])
  let cur: BlockItem | undefined
  for (let i = prevBlock.items.length - 1; i >= 0; i--) {
    if (prevBlock.items[i].lineNumber < lineNumber) {
      cur = prevBlock.items[i]
      break
    }
  }
  if (!cur) return null
  while (cur) {
    cols.add(cur.parsed.lead + cur.parsed.markerWidth)
    if (cur.parentLine === null) break
    const parentIdx = prevBlock.itemIndexByLine.get(cur.parentLine)
    cur = parentIdx !== undefined ? prevBlock.items[parentIdx] : undefined
  }
  return { levels: [...cols].sort((a, b) => a - b) }
}

function indentSingleLine(view: EditorView, lineNumber: number, direction: 1 | -1): boolean {
  const { state } = view
  const { tree, fmEnd } = getTreeAndFm(state)
  const range = state.selection.main
  const line = state.doc.line(lineNumber)
  const self = parseListLine(line.text)

  if (!self) {
    const quotePrefix = QUOTE_PREFIX_RE.exec(line.text)?.[0] ?? ''
    const quoteLen = quotePrefix.length
    const bodyFrom = line.from + quoteLen
    const body = line.text.slice(quoteLen)
    const leadRaw = /^[ \t]*/.exec(body)?.[0] ?? ''

    // 紧贴列表块下方的非空普通行：行首 Tab 按上级列表正文对齐（用空格，避免叠 \t 且自动接回下半段序号），
    // Shift+Tab 逐级干净退回顶格（不再走默认 2 空格退格卡在半截缩进）。
    if (body.trim() !== '') {
      const cont = findContinuationAlign(state.doc, tree, fmEnd, lineNumber, countQuotes(quotePrefix))
      if (cont) {
        const curCols = expandIndent(leadRaw)
        if (direction === 1 && range.empty && range.head <= bodyFrom + leadRaw.length) {
          const nextCols = cont.levels.find((c) => c > curCols)
          if (nextCols === undefined) return true
          const replacement = ' '.repeat(nextCols)
          view.dispatch({
            changes: { from: bodyFrom, to: bodyFrom + leadRaw.length, insert: replacement },
            selection: { anchor: bodyFrom + replacement.length },
            scrollIntoView: true,
            userEvent: 'input',
          })
          return true
        }
        if (direction === -1 && leadRaw.length > 0) {
          const prevCols = [...cont.levels].reverse().find((c) => c < curCols) ?? 0
          const replacement = ' '.repeat(prevCols)
          const changes = state.changes({ from: bodyFrom, to: bodyFrom + leadRaw.length, insert: replacement })
          const anchor = Math.min(changes.newLength, Math.max(bodyFrom + replacement.length, changes.mapPos(range.head, -1)))
          view.dispatch({
            changes,
            selection: { anchor },
            scrollIntoView: true,
            userEvent: 'input',
          })
          return true
        }
      }
    }

    if (!quotePrefix) {
      // 普通非列表行（非代码围栏）在空选区按 Tab 插入制表符而非调用 indentMore 强推整行首空格，
      // 避免敲完 `1.` / `-` 按 Tab 时整行缩进或误触发列表续行；Shift+Tab 交回默认减缩进。
      if (direction === 1 && range.empty) {
        view.dispatch({
          changes: { from: range.head, to: range.head, insert: '\t' },
          selection: { anchor: range.head + 1 },
          scrollIntoView: true,
          userEvent: 'input',
        })
        return true
      }
      return false
    }
    if (direction === 1) {
      const at = Math.max(range.head, bodyFrom)
      // 引用内普通行按 Tab 写制表符而非空格，避免 `> 1.` / `> -` 后按 Tab 误触发列表格式
      view.dispatch({
        changes: { from: at, to: at, insert: '\t' },
        selection: { anchor: at + 1 },
        scrollIntoView: true,
        userEvent: 'input',
      })
      return true
    }
    const spaces = /^[ \t]+/.exec(body)?.[0] ?? ''
    if (!spaces) return true
    const edit = adjustLeadEdit(spaces, -BULLET_INDENT)
    if (edit.removeChars === 0 && edit.replaceWith === '') return true
    const changes = state.changes({ from: bodyFrom, to: bodyFrom + edit.removeChars, insert: edit.replaceWith })
    const anchor = Math.min(changes.newLength, Math.max(bodyFrom, changes.mapPos(range.head, -1)))
    view.dispatch({
      changes,
      selection: { anchor },
      scrollIntoView: true,
      userEvent: 'input',
    })
    return true
  }

  const block = scanListBlock(state.doc, lineNumber, tree, fmEnd)
  const blockIdx = block?.itemIndexByLine.get(lineNumber)
  const blockItem: BlockItem | null = block && blockIdx !== undefined ? block.items[blockIdx] : null
  const subtreeEnd = blockItem ? blockItem.subtreeEndLine : lineNumber

  if (direction === 1) {
    // 必须有同一连续块内的上方合法父项；首项或已比上方深 1 级时吃掉 Tab，绝不推成代码块
    const parent = block ? findIndentParent(block, lineNumber, self.lead) : null
    if (!parent) return true

    const step = parent.parsed.kind === 'ordered' ? ORDERED_INDENT : BULLET_INDENT
    const targetLead = Math.max(parent.parsed.lead + parent.parsed.markerWidth, parent.parsed.lead + step)
    const delta = targetLead - self.lead
    if (delta <= 0) return true

    const specs: { from: number; to: number; insert: string }[] = []
    for (let ln = lineNumber; ln <= subtreeEnd; ln++) {
      const subLine = state.doc.line(ln)
      const qLen = QUOTE_PREFIX_RE.exec(subLine.text)?.[0].length ?? 0
      const leadRaw = /^[ \t]*/.exec(subLine.text.slice(qLen))?.[0] ?? ''
      const edit = adjustLeadEdit(leadRaw, delta)
      const at = subLine.from + qLen
      specs.push({ from: at, to: at + edit.removeChars, insert: edit.replaceWith })
    }
    const changes = state.changes(specs)
    const anchor = Math.min(changes.newLength, Math.max(0, changes.mapPos(range.head, 1)))
    view.dispatch({
      changes,
      selection: { anchor },
      scrollIntoView: true,
      userEvent: 'input',
    })
    return true
  }

  // Shift+Tab 退缩进
  if (self.lead === 0) return true
  const parent = block ? findOutdentTarget(block, lineNumber) : null
  const targetLead = parent ? parent.parsed.lead : 0
  const delta = self.lead - targetLead
  if (delta <= 0) return true

  const specs: { from: number; to: number; insert: string }[] = []
  for (let ln = lineNumber; ln <= subtreeEnd; ln++) {
    const subLine = state.doc.line(ln)
    const qLen = QUOTE_PREFIX_RE.exec(subLine.text)?.[0].length ?? 0
    const leadMatch = /^[ \t]*/.exec(subLine.text.slice(qLen))?.[0] ?? ''
    const edit = adjustLeadEdit(leadMatch, -delta)
    if (edit.removeChars > 0 || edit.replaceWith !== '') {
      specs.push({ from: subLine.from + qLen, to: subLine.from + qLen + edit.removeChars, insert: edit.replaceWith })
    }
  }
  if (specs.length === 0) return true
  const changes = state.changes(specs)
  const lineStartInNew = changes.mapPos(state.doc.line(lineNumber).from, -1)
  const nextAnchor = Math.min(
    changes.newLength,
    Math.max(lineStartInNew + self.quoteLen, changes.mapPos(range.head, -1)),
  )
  view.dispatch({
    changes,
    selection: { anchor: nextAnchor },
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

function indentMultiLineSelection(
  view: EditorView,
  startLineNum: number,
  endLineNum: number,
  direction: 1 | -1,
): boolean {
  const { state } = view
  const { tree, fmEnd } = getTreeAndFm(state)
  let firstListLine = -1
  let firstParsed: ParsedListLine | null = null
  for (let ln = startLineNum; ln <= endLineNum; ln++) {
    if (isExcludedLine(state.doc, tree, ln, fmEnd)) continue
    const parsed = parseListLine(state.doc.line(ln).text)
    if (parsed) {
      firstListLine = ln
      firstParsed = parsed
      break
    }
  }
  if (firstListLine < 0 || !firstParsed) return false

  // 确认整批里第一条列表项在 direction === 1 时上方存在父项（避免把列表首项推进代码块）
  let indentStep = firstParsed.kind === 'ordered' ? ORDERED_INDENT : BULLET_INDENT
  if (direction === 1) {
    const block = scanListBlock(state.doc, firstListLine, tree, fmEnd)
    const parent = block ? findIndentParent(block, firstListLine, firstParsed.lead) : null
    if (!parent) return true
    const step = parent.parsed.kind === 'ordered' ? ORDERED_INDENT : BULLET_INDENT
    indentStep = Math.max(parent.parsed.lead + parent.parsed.markerWidth, parent.parsed.lead + step) - firstParsed.lead
    if (indentStep <= 0) return true
  }

  const specs: { from: number; to: number; insert: string }[] = []
  for (let ln = startLineNum; ln <= endLineNum; ln++) {
    if (isExcludedLine(state.doc, tree, ln, fmEnd)) continue
    const line = state.doc.line(ln)
    const qLen = QUOTE_PREFIX_RE.exec(line.text)?.[0].length ?? 0
    if (line.text.slice(qLen).trim() === '') continue
    if (direction === 1) {
      const leadRaw = /^[ \t]*/.exec(line.text.slice(qLen))?.[0] ?? ''
      const edit = adjustLeadEdit(leadRaw, indentStep)
      const at = line.from + qLen
      specs.push({ from: at, to: at + edit.removeChars, insert: edit.replaceWith })
    } else {
      const parsed = parseListLine(line.text)
      const step = parsed?.kind === 'bullet' ? BULLET_INDENT : ORDERED_INDENT
      const leadMatch = /^[ \t]*/.exec(line.text.slice(qLen))?.[0] ?? ''
      const edit = adjustLeadEdit(leadMatch, -step)
      if (edit.removeChars > 0 || edit.replaceWith !== '') {
        specs.push({ from: line.from + qLen, to: line.from + qLen + edit.removeChars, insert: edit.replaceWith })
      }
    }
  }

  if (specs.length === 0) return true
  const changes = state.changes(specs)
  const sel = state.selection.main
  view.dispatch({
    changes,
    selection: EditorSelection.range(changes.mapPos(sel.anchor, 1), changes.mapPos(sel.head, 1)),
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

/**
 * Home / Cmd+Left：在有序列表项的第一视觉行上落到正文首字前（而不是 `1.` 左边）；
 * 软折行到第二+视觉行时保留回到当前视觉行首的原生行为。
 */
function moveOrderedLineStart(view: EditorView, select: boolean): boolean {
  const { state } = view
  if (state.selection.ranges.length > 1) return false
  const range = state.selection.main
  const { tree, fmEnd } = getTreeAndFm(state)
  const line = state.doc.lineAt(range.head)
  const self = isActiveOrderedListLine(state.doc, tree, line.number, fmEnd)
  if (!self) return false
  // 软折行下先测当前视觉行首，只有回到物理行首（即在第一视觉行）时才重定向到正文首字前
  const boundary = view.moveToLineBoundary(range, false)
  if (boundary.head > line.from + self.contentOffset) return false
  const target = line.from + self.contentOffset
  view.dispatch({
    selection: select ? EditorSelection.range(range.anchor, target) : EditorSelection.cursor(target),
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
}

/** ArrowLeft / Option+Left：从有序列表正文首字前按左，直接跳到上一行末尾，不落进 `1.` 左边。 */
function moveOrderedLeft(view: EditorView): boolean {
  const { state } = view
  if (state.selection.ranges.length > 1) return false
  const range = state.selection.main
  if (!range.empty) return false
  const { tree, fmEnd } = getTreeAndFm(state)
  const line = state.doc.lineAt(range.head)
  const self = isActiveOrderedListLine(state.doc, tree, line.number, fmEnd)
  if (!self) return false
  const contentStart = line.from + self.contentOffset
  if (range.head > contentStart) return false
  const target = line.number > 1 ? state.doc.line(line.number - 1).to : contentStart
  view.dispatch({
    selection: EditorSelection.cursor(target),
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
}

/** ArrowRight：在行尾按右且下一行是有序列表项时，一步跨过下一行 `2. ` 落到正文首字前。 */
function moveOrderedRight(view: EditorView): boolean {
  const { state } = view
  if (state.selection.ranges.length > 1) return false
  const range = state.selection.main
  if (!range.empty) return false
  const { tree, fmEnd } = getTreeAndFm(state)
  const line = state.doc.lineAt(range.head)
  if (range.head !== line.to || line.number >= state.doc.lines) return false
  const nextLine = state.doc.line(line.number + 1)
  const nextSelf = isActiveOrderedListLine(state.doc, tree, nextLine.number, fmEnd)
  if (!nextSelf) return false
  const target = nextLine.from + nextSelf.contentOffset
  view.dispatch({
    selection: EditorSelection.cursor(target),
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
}

/**
 * 渲染模式下光标守护：
 * 鼠标点击（`select.pointer`）或键盘上下移动（`select`）把空光标落进受保护有序列表行
 * 左侧缩进空白或序号 `1. ` 前缀里时，自动落到正文首字前，避免误打出 `你好1. 甲`
 * 或把 `1.` 敲成 `10.` 触发整张表重排；多光标时逐个修正而不销毁其余光标。
 * 程序化 `dispatch({ selection })`（无 userEvent）放行，不影响测试与源码操作。
 */
const orderedSelectionGuard = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.selection) return tr
  const event = tr.annotation(Transaction.userEvent)
  if (!event || !event.startsWith('select')) return tr
  const doc = tr.startState.doc
  const tree = syntaxTree(tr.startState)
  const fmEnd = frontmatterEnd(doc)
  let changed = false
  const nextRanges = tr.selection.ranges.map((r) => {
    if (!r.empty) return r
    const line = doc.lineAt(r.head)
    const self = isActiveOrderedListLine(doc, tree, line.number, fmEnd)
    if (!self) return r
    const contentStart = line.from + self.contentOffset
    if (r.head >= contentStart) return r
    changed = true
    return EditorSelection.cursor(contentStart, r.assoc, r.bidiLevel ?? undefined, r.goalColumn)
  })
  if (!changed) return tr
  return {
    selection: EditorSelection.create(nextRanges, tr.selection.mainIndex),
    effects: tr.effects,
    userEvent: event,
    scrollIntoView: tr.scrollIntoView,
  }
})

/**
 * 双击有序列表序号（`.cm-md-listmark`）：直接选中纯数字区间，方便修改列表起始号
 * （改完由 list-renumber 同事务顺延同组后续项）。单击仍走 orderedSelectionGuard 落正文首字前。
 * 用 domEventHandlers 直接 dispatch 而非 mouseSelectionStyle，避免 CM6 把选区右端按
 * listPrefixAtomicRanges 扩到 `. ` 后面。
 */
const selectOrderedMarkOnDoubleClick = Prec.high(EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || event.detail !== 2 || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
      return false
    }
    const target = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement ?? null
    const markEl = target?.closest('.cm-md-listmark')
    if (!markEl) return false
    let pos: number
    try {
      pos = view.posAtDOM(markEl)
    } catch {
      return false
    }
    const { doc } = view.state
    const line = doc.lineAt(Math.min(pos, doc.length))
    const self = isActiveOrderedListLine(doc, syntaxTree(view.state), line.number, frontmatterEnd(doc))
    if (!self || !self.digits) return false
    const from = line.from + self.markerStart
    const to = from + self.digits.length
    event.preventDefault()
    view.focus()
    view.dispatch({
      selection: EditorSelection.range(from, to),
      userEvent: 'select.pointer',
    })
    return true
  },
}))

export const listInput: Extension = [
  selectOrderedMarkOnDoubleClick,
  orderedSelectionGuard,
  Prec.high(keymap.of([
    { key: 'Enter', run: handleEnter },
    { key: 'Shift-Enter', run: handleShiftEnter },
    { key: 'Backspace', run: deleteTaskBox },
    { key: 'Backspace', run: deleteAtLineStart },
    { key: 'Backspace', run: deleteMarkupBackward },
    { key: 'Tab', run: (view) => handleTab(view, 1) },
    { key: 'Shift-Tab', run: (view) => handleTab(view, -1) },
    { key: 'Home', run: (view) => moveOrderedLineStart(view, false) },
    { key: 'Shift-Home', run: (view) => moveOrderedLineStart(view, true) },
    { key: 'Mod-ArrowLeft', run: (view) => moveOrderedLineStart(view, false) },
    { key: 'Shift-Mod-ArrowLeft', run: (view) => moveOrderedLineStart(view, true) },
    { key: 'ArrowLeft', run: moveOrderedLeft },
    { key: 'Alt-ArrowLeft', run: moveOrderedLeft },
    { key: 'ArrowRight', run: moveOrderedRight },
  ])),
]
