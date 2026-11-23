// 有序列表的序号重排引擎：基于行级结构模型，跟着编辑走并写回文件。
//
// 设计原则：
//   1. 文件里的数就是屏幕上的数：编辑结构变化时，把正确序号同事务写回缓冲区，
//      撤销一次一起回到改前；打开文件、外部写入、导出、撤销/重做一概不碰。
//   2. 只在结构变化或序号被直接改动时重排；在正文里正常打字不动已有序号。
//   3. 隔空行即独立列表（不跨空行联动）；失去首项或被劈开的下半段自动从 1 起算，
//      彻底消除 CommonMark「紧跟段落后 2. 不是列表」导致整张列表格式丢失的问题。
//   4. 当父项序号进位（如 9. -> 10.）导致既有子项缩进不足时，同步补齐子树缩进，
//      绝不让子列表脱钩掉到外层。

import { ChangeSet, EditorState, Transaction, type Extension, type Text } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { MarkdownParser } from '@lezer/markdown'
import type { SyntaxNode, Tree } from '@lezer/common'
import {
  QUOTE_PREFIX_RE,
  adjustLeadEdit,
  expandIndent,
  frontmatterEnd,
  isExcludedLine,
  parseListLine,
  scanListBlock,
  type BlockItem,
  type ListBlock,
  type OrderedGroup,
} from './list-model'

interface OldItemRef {
  item: BlockItem
  group: OrderedGroup
  indexInGroup: number
}

const EXCLUDED_NODES = new Set(['FencedCode', 'HTMLBlock', 'Table', 'CommentBlock'])
/** 全量解析阈值（字节）：小于此值直接局部全篇解析，大文档则切窗口解析。 */
const FULL_PARSE_LIMIT = 65536
/** 大文档窗口解析向上回溯的安全行数上限。 */
const WINDOW_PAD_LINES = 128

/** 防重入：补丁事务会再次经过 transactionFilter。 */
let patching = false

export function createRenumberLists(parser: MarkdownParser): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || patching) return tr
    const event = tr.annotation(Transaction.userEvent)
    // 只认用户编辑；程序化加载、外部同步、撤销/重做与 IME 组字期间一概放行。
    if (!event || event.startsWith('undo') || event.startsWith('redo') || event.includes('compose')) return tr

    const oldDoc = tr.startState.doc
    const newDoc = tr.newDoc
    const oldTree = syntaxTree(tr.startState)
    const oldFmEnd = frontmatterEnd(oldDoc)
    const newFmEnd = frontmatterEnd(newDoc)

    // 快速通道：改动邻域（改前/改后上下各扩 1 行）没有任何有序列表行时直接放行，零开销。
    // 先跑廉价的 parseListLine，再查排除块，避免普通大段粘贴触发不必要的语法树查询。
    const oldSeedLines = collectSeedLines(oldDoc, tr.changes, true)
    const newSeedLines = collectSeedLines(newDoc, tr.changes, false)

    const hasOldOrdered = oldSeedLines.some(
      (n) => parseListLine(oldDoc.line(n).text)?.kind === 'ordered' && !isExcludedLine(oldDoc, oldTree, n, oldFmEnd),
    )
    const hasNewOrderedCandidate = newSeedLines.some(
      (n) => parseListLine(newDoc.line(n).text)?.kind === 'ordered',
    )
    if (!hasOldOrdered && !hasNewOrderedCandidate) return tr

    // 基于 newDoc 构建精准的新文档排除区查询器（彻底覆盖粘贴代码块、围栏闭合后新建列表等场景）
    const isExcludedInNew = buildNewDocExcluder(newDoc, newSeedLines, newFmEnd, parser)

    const hasNewOrdered =
      hasNewOrderedCandidate &&
      newSeedLines.some((n) => parseListLine(newDoc.line(n).text)?.kind === 'ordered' && !isExcludedInNew(n))

    if (!hasOldOrdered && !hasNewOrdered) return tr

    // 收集受改动影响的旧连续块（用于判定每条新项的前世身份）
    const oldBlocks = collectBlocks(oldDoc, oldSeedLines, oldTree, oldFmEnd)
    // 建立「新行号 -> 对应的存活旧有序项」映射
    const oldRefByNewLine = mapSurvivingOldItems(oldBlocks, tr.changes, newDoc)

    // 收集受改动影响的新连续块（去重、按行号升序）
    const newBlocks = collectNewBlocks(newDoc, newSeedLines, newFmEnd, isExcludedInNew)
    if (newBlocks.length === 0) return tr

    const markChanges = new Map<number, { from: number; to: number; insert: string }>()
    const indentAddByLine = new Map<number, number>()

    for (const block of newBlocks) {
      // 按出现顺序（自顶向下）处理各组，确保父项先确定新宽度与追加缩进，再保护子项
      for (const group of block.orderedGroups) {
        const plan = decideGroupRenumber(group, oldRefByNewLine)
        if (!plan.run) continue

        const start = plan.start
        group.items.forEach((item, idx) => {
          const line = newDoc.line(item.lineNumber)
          const wantDigits = String(start + idx)
          const wantMark = `${wantDigits}${item.parsed.delim}`
          const currentDigits = item.parsed.digits
          if (wantDigits !== currentDigits) {
            markChanges.set(item.lineNumber, {
              from: line.from + item.parsed.markerStart,
              to: line.from + item.parsed.markerEnd,
              insert: wantMark,
            })
          }

          // 守护子项缩进：仅当本项序号确实变宽（如 9. -> 10.）或本项自身被右移时，
          // 检查直属子项是否小于新正文列，避免未变宽时误改用户既有 2 空格子项。
          const ownAdded = indentAddByLine.get(item.lineNumber) ?? 0
          const grew = wantDigits.length > currentDigits.length || ownAdded > 0
          if (grew && item.subtreeEndLine > item.lineNumber) {
            const spacesRaw = line.text.slice(item.parsed.markerEnd, item.parsed.spaceEnd)
            const newParentLead = item.parsed.lead + ownAdded
            const newMarkerWidth = wantMark.length + expandIndent(spacesRaw, newParentLead + wantMark.length)
            const minChildCol = newParentLead + newMarkerWidth

            let minDirectChildLead = Infinity
            const itemIdx = block.itemIndexByLine.get(item.lineNumber)
            if (itemIdx !== undefined) {
              for (let j = itemIdx + 1; j < block.items.length; j++) {
                const candidate = block.items[j]
                if (candidate.depth <= item.depth) break
                if (candidate.parentLine === item.lineNumber) {
                  const candLead = candidate.parsed.lead + (indentAddByLine.get(candidate.lineNumber) ?? 0)
                  if (candLead < minDirectChildLead) minDirectChildLead = candLead
                }
              }
            }

            if (Number.isFinite(minDirectChildLead) && minDirectChildLead < minChildCol) {
              const delta = minChildCol - minDirectChildLead
              for (let ln = item.lineNumber + 1; ln <= item.subtreeEndLine; ln++) {
                indentAddByLine.set(ln, (indentAddByLine.get(ln) ?? 0) + delta)
              }
            }
          }
        })
      }
    }

    if (markChanges.size === 0 && indentAddByLine.size === 0) return tr

    // 组装不重叠、按偏移严格升序的补丁集
    const changes: { from: number; to: number; insert: string }[] = []
    const affectedLines = new Set<number>([...markChanges.keys(), ...indentAddByLine.keys()])
    const sortedLines = [...affectedLines].sort((a, b) => a - b)

    for (const ln of sortedLines) {
      const line = newDoc.line(ln)
      const addSpaces = indentAddByLine.get(ln) ?? 0
      if (addSpaces > 0) {
        const quoteLen = QUOTE_PREFIX_RE.exec(line.text)?.[0].length ?? 0
        const leadRaw = /^[ \t]*/.exec(line.text.slice(quoteLen))?.[0] ?? ''
        const edit = adjustLeadEdit(leadRaw, addSpaces)
        const at = line.from + quoteLen
        changes.push({ from: at, to: at + edit.removeChars, insert: edit.replaceWith })
      }
      const mc = markChanges.get(ln)
      if (mc) changes.push(mc)
    }

    if (changes.length === 0) return tr

    const patch = ChangeSet.of(changes, newDoc.length)
    patching = true
    try {
      return tr.startState.update({
        changes: tr.changes.compose(patch),
        // assoc=1：光标贴在序号后面（如 `1. |`）时，序号变宽（如变成 `10. `）后光标仍留在空格后
        selection: tr.selection ? tr.selection.map(patch, 1) : undefined,
        effects: tr.effects,
        userEvent: event,
        scrollIntoView: tr.scrollIntoView,
      })
    } finally {
      patching = false
    }
  })
}

function collectSeedLines(doc: Text, changes: ChangeSet, isOld: boolean): number[] {
  const lines = new Set<number>()
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const from = isOld ? fromA : fromB
    const to = isOld ? toA : toB
    const startLine = Math.max(1, doc.lineAt(Math.min(from, doc.length)).number - 1)
    const endLine = Math.min(doc.lines, doc.lineAt(Math.min(to, doc.length)).number + 1)
    for (let n = startLine; n <= endLine; n++) lines.add(n)
  })
  return [...lines].sort((a, b) => a - b)
}

/**
 * 为 `newDoc` 构造精确的排除行判定器（属性区、围栏代码块、HTML 块、表格、注释块）。
 * 小于 64KB 直接对新文档跑一次快速语法解析；超大文档仅切片解析受影响窗口。
 */
function buildNewDocExcluder(
  newDoc: Text,
  seedLines: number[],
  newFmEnd: number,
  parser: MarkdownParser,
): (lineNumber: number) => boolean {
  let sliceFrom = 0
  let sliceTo = newDoc.length
  if (newDoc.length > FULL_PARSE_LIMIT && seedLines.length > 0) {
    const minLine = Math.max(1, seedLines[0] - WINDOW_PAD_LINES)
    const maxLine = Math.min(newDoc.lines, seedLines[seedLines.length - 1] + WINDOW_PAD_LINES)
    sliceFrom = newDoc.line(minLine).from
    sliceTo = newDoc.line(maxLine).to
  }
  const tree = parser.parse(newDoc.sliceString(sliceFrom, sliceTo))
  const cache = new Map<number, boolean>()

  return (lineNumber: number): boolean => {
    const hit = cache.get(lineNumber)
    if (hit !== undefined) return hit
    const line = newDoc.line(lineNumber)
    let excluded = false
    if (newFmEnd >= 0 && line.from <= newFmEnd) {
      excluded = true
    } else if (line.from >= sliceFrom && line.from <= sliceTo) {
      const qLen = QUOTE_PREFIX_RE.exec(line.text)?.[0].length ?? 0
      const probe = Math.min(line.to, line.from + qLen) - sliceFrom
      let node: SyntaxNode | null = tree.resolveInner(Math.min(Math.max(0, probe), tree.length), 1)
      while (node) {
        if (EXCLUDED_NODES.has(node.name)) {
          excluded = true
          break
        }
        node = node.parent
      }
    }
    cache.set(lineNumber, excluded)
    return excluded
  }
}

function collectBlocks(doc: Text, seedLines: number[], tree: Tree, fmEnd: number): ListBlock[] {
  const blocks: ListBlock[] = []
  let coveredUntil = 0
  for (const ln of seedLines) {
    if (ln <= coveredUntil) continue
    const block = scanListBlock(doc, ln, tree, fmEnd)
    if (!block) continue
    blocks.push(block)
    coveredUntil = block.endLine
  }
  return blocks
}

function collectNewBlocks(
  newDoc: Text,
  seedLines: number[],
  newFmEnd: number,
  isExcludedInNew: (lineNumber: number) => boolean,
): ListBlock[] {
  const blocks: ListBlock[] = []
  let coveredUntil = 0
  for (const ln of seedLines) {
    if (ln <= coveredUntil) continue
    const block = scanListBlock(newDoc, ln, null, newFmEnd, isExcludedInNew)
    if (!block) continue
    blocks.push(block)
    coveredUntil = block.endLine
  }
  return blocks
}

/**
 * 把改前存活下来的旧有序项映射到改后的新行号。
 * 被整段删除或跨行覆盖替换的旧项不参与映射，防止旧身份错挂到下方顶上来的新项或粘贴文本。
 */
function mapSurvivingOldItems(
  oldBlocks: ListBlock[],
  changes: ChangeSet,
  newDoc: Text,
): Map<number, OldItemRef> {
  const map = new Map<number, OldItemRef>()
  for (const block of oldBlocks) {
    for (const group of block.orderedGroups) {
      group.items.forEach((item, indexInGroup) => {
        const markFrom = item.lineFrom + item.parsed.markerStart
        const markTo = item.lineFrom + item.parsed.markerEnd
        if (wasItemDestroyed(changes, item, markFrom, markTo)) return
        const mappedPos = changes.mapPos(markFrom, 1)
        if (mappedPos > newDoc.length) return
        const newLine = newDoc.lineAt(mappedPos)
        const newParsed = parseListLine(newLine.text)
        if (!newParsed || newParsed.kind !== 'ordered') return
        // 映射落点必须在目标新行的标记区间附近，避免漂移到别行正文末尾
        const minOk = newLine.from + newParsed.quoteLen
        const maxOk = newLine.from + newParsed.contentOffset
        if (mappedPos < minOk || mappedPos > maxOk) return
        if (!map.has(newLine.number)) {
          map.set(newLine.number, { item, group, indexInGroup })
        }
      })
    }
  }
  return map
}

function wasItemDestroyed(
  changes: ChangeSet,
  item: BlockItem,
  markFrom: number,
  markTo: number,
): boolean {
  let destroyed = false
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (destroyed) return
    if (fromA <= markFrom && toA >= markTo) {
      // 1. 标记被纯删除（未插入替代文本）
      // 2. 标记被包含在跨行的大块替换（如全选粘贴覆盖）里
      if (toB === fromB || fromA < item.lineFrom || toA > item.lineTo) {
        destroyed = true
      }
    }
  })
  return destroyed
}

function decideGroupRenumber(
  group: OrderedGroup,
  oldRefByNewLine: Map<number, OldItemRef>,
): { run: boolean; start: number } {
  const refs = group.items.map((item) => oldRefByNewLine.get(item.lineNumber) ?? null)
  const firstRef = refs[0]

  let needsRenumber = false
  const distinctOldGroups = new Set<OrderedGroup>()

  for (let i = 0; i < group.items.length; i++) {
    const item = group.items[i]
    const ref = refs[i]
    if (!ref) {
      // 有新诞生的有序项（回车续行、刚敲完 `1. `、粘贴等）
      needsRenumber = true
      continue
    }
    distinctOldGroups.add(ref.group)
    if (ref.item.depth !== item.depth) {
      // 缩进层级发生了变化（Tab / Shift+Tab）
      needsRenumber = true
    }
    if (ref.item.parsed.digits !== item.parsed.digits || ref.item.parsed.delim !== item.parsed.delim) {
      // 用户直接修改了这一项的序号或分隔符
      needsRenumber = true
    }
  }

  if (!needsRenumber) {
    if (distinctOldGroups.size !== 1) {
      // 两张旧表合并或来源混杂
      needsRenumber = true
    } else {
      const [onlyOldGroup] = distinctOldGroups
      if (onlyOldGroup.items.length !== group.items.length) {
        // 组内增删了项、或被劈成了两段
        needsRenumber = true
      }
    }
  }

  if (!needsRenumber) return { run: false, start: 1 }

  // 决定起始号：
  //   1. 原首项被删/取消格式/或被空行普通行从上面劈开，当前暴露出的首项原本是组内第 2+ 项 -> 归 1！
  //   2. 当前项刚被缩进成更深层的新子列表第一项 -> 归 1！
  //   3. 其它情况（本来就是首项，或刚手敲 `5. ` 开启新表）-> 保留首项真实数字。
  if (firstRef) {
    const firstItem = group.items[0]
    if (firstRef.indexInGroup > 0) {
      return { run: true, start: 1 }
    }
    if (firstItem.depth > firstRef.item.depth) {
      return { run: true, start: 1 }
    }
  }

  const parsedStart = Number.parseInt(group.items[0].parsed.digits, 10)
  return { run: true, start: Number.isFinite(parsedStart) && parsedStart >= 0 ? parsedStart : 1 }
}
