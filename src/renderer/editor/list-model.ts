// 列表的共享结构模型（无 DOM 依赖，供 list-renumber、list-input、live-preview、core 共用）。
//
// 为什么不把编辑行为和重排完全绑死在 CommonMark 语法树上：
//   1. CommonMark 规定紧跟普通段落下方，只有「非空且从 1. 开始」的项能打断段落：
//      删掉 `1. 测试 / 2. 测试 / 3. ` 里的 `1. ` 后，语法树把整段判成单个 Paragraph，
//      重排器如果只看语法树就会当场失明，`2. / 3.` 既不归 `1. / 2.`，格式也瞬间全丢。
//   2. 紧跟普通段落下方刚敲完 `1. `（还没打字）也是「空列表项」，CommonMark 同样把它
//      判成 Paragraph，导致敲完空格不出列表格式，非得再打字才变格式。
//   3. 父项从 `9.` 涨成 `10.` 时，原本 3 空格缩进的子项会因为宽度差 1 格被解析器踢到外层。
//
// 这里把「连续非空列表块」的层级、父子、同级分组和子树范围统一算清楚；
// 语法树只负责排除围栏代码块、HTML 块、表格、属性区等真正的非列表块。

import type { Text } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { frontmatterRange } from './math-scan'

/** 引用前缀：每层 `>` 最多吃掉后面紧跟的一个空格或制表符（与 live-preview hideMarker 对齐），其余空白归列表缩进。 */
export const QUOTE_PREFIX_RE = /^(?:[ \t]*>[ \t]?)+/

/**
 * 剥掉引用前缀后的列表行：缩进 + 标记 + 普通空格 + 可选的任务框。
 * 有序序号按 CommonMark 规范最多 9 位，且标记后必须至少跟一个普通空格才成型
 * （按 Tab 产生的制表符不触发列表格式；行首前导缩进仍支持空格与 Tab）。
 */
export const LIST_BODY_RE = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))( +)(\[[ xX]\] +)?/

/** 有序列表默认每级缩进宽度：4 空格，保证 9. 涨成 10. 时子项绝不脱钩。 */
export const ORDERED_INDENT = 4

/** 无序列表默认每级缩进宽度：2 空格（与 `- ` 宽度一致）。 */
export const BULLET_INDENT = 2

/** 连续列表块扫描上限，防止极端大文档无限扫描。 */
export const MAX_BLOCK_LINES = 5000

export interface ParsedListLine {
  quotePrefix: string
  quoteLen: number
  quoteDepth: number
  /** 引用前缀后的原始缩进字符数 */
  leadChars: number
  /** 引用前缀后的展开列宽（空格=1，Tab=4 列对齐） */
  lead: number
  kind: 'ordered' | 'bullet'
  /** 有序项的纯数字文本，无序项为空串 */
  digits: string
  /** 有序项分隔符 '.' 或 ')'，无序项为空串 */
  delim: '.' | ')' | ''
  /** 无序项符号，有序项为空串 */
  bullet: string
  /** 标记起始偏移（相对 line.from） */
  markerStart: number
  /** 标记结束偏移（不含标记后空白） */
  markerEnd: number
  /** 标记及后随空白结束偏移（不含任务框） */
  spaceEnd: number
  /** 标记 + 后随空白宽度 */
  markerWidth: number
  /** 任务框及后随空白（如 `"[ ] "`），无则为空串 */
  box: string
  /** 正文起始偏移（相对 line.from） */
  contentOffset: number
  /** 去掉前缀后是否为空项 */
  isEmpty: boolean
}

export interface BlockItem {
  lineNumber: number
  lineFrom: number
  lineTo: number
  parsed: ParsedListLine
  depth: number
  parentLine: number | null
  groupId: number
  /** 该项名下整棵子树（含子孙项与项内续行）覆盖到的最后一行号 */
  subtreeEndLine: number
}

export interface OrderedGroup {
  id: number
  parentLine: number | null
  depth: number
  delim: '.' | ')'
  items: BlockItem[]
}

export interface ListBlock {
  startLine: number
  endLine: number
  quoteDepth: number
  items: BlockItem[]
  orderedGroups: OrderedGroup[]
  /** 行号到 items 下标的 O(1) 索引 */
  itemIndexByLine: Map<number, number>
}

/**
 * 按展开列宽增减前导空白 `leadRaw` 的精确字符替换（支持 Tab 4 列对齐与空格混用）。
 *
 * - `deltaCols < 0`（退缩进）：按总列宽精确减列，不把 2 个 Tab 当 2 个字符一口吞光，
 *   也不出现删掉 Tab 前空格后剩余 Tab 自动补宽导致列数未变。
 * - `deltaCols > 0`（加缩进）：纯空格直接在最前插空格；含 Tab 时按目标列宽规范化，
 *   避免在 `\t` 前插 1–2 个空格后 `expandIndent(" \t")` 仍为 4 列实际未右移。
 */
export function adjustLeadEdit(
  leadRaw: string,
  deltaCols: number,
): { removeChars: number; replaceWith: string } {
  if (deltaCols === 0) return { removeChars: 0, replaceWith: '' }
  if (deltaCols > 0) {
    if (!leadRaw.includes('\t')) {
      return { removeChars: 0, replaceWith: ' '.repeat(deltaCols) }
    }
    const targetCols = expandIndent(leadRaw) + deltaCols
    return { removeChars: leadRaw.length, replaceWith: ' '.repeat(targetCols) }
  }
  if (leadRaw.length === 0) return { removeChars: 0, replaceWith: '' }
  const totalCols = expandIndent(leadRaw)
  const targetCols = Math.max(0, totalCols + deltaCols)
  if (targetCols === 0) {
    return { removeChars: leadRaw.length, replaceWith: '' }
  }
  if (!leadRaw.includes('\t')) {
    return { removeChars: Math.min(leadRaw.length, -deltaCols), replaceWith: '' }
  }
  if (/^\t+$/.test(leadRaw) && targetCols % 4 === 0) {
    const keepTabs = targetCols / 4
    return { removeChars: leadRaw.length - keepTabs, replaceWith: '' }
  }
  return { removeChars: leadRaw.length, replaceWith: ' '.repeat(targetCols) }
}

export function countQuotes(prefix: string): number {
  let count = 0
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] === '>') count++
  }
  return count
}

export function expandIndent(raw: string, startCol = 0): number {
  let cols = startCol
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\t') cols += 4 - (cols % 4)
    else cols += 1
  }
  return cols - startCol
}

export function parseListLine(text: string): ParsedListLine | null {
  const quotePrefix = QUOTE_PREFIX_RE.exec(text)?.[0] ?? ''
  const quoteLen = quotePrefix.length
  const match = LIST_BODY_RE.exec(text.slice(quoteLen))
  if (!match) return null
  const leadRaw = match[1]
  const leadChars = leadRaw.length
  const lead = expandIndent(leadRaw)
  const bullet = match[2] ?? ''
  const digits = match[3] ?? ''
  const delim = (match[4] ?? '') as '.' | ')' | ''
  const spaces = match[5]
  const box = match[6] ?? ''
  const kind: 'ordered' | 'bullet' = digits ? 'ordered' : 'bullet'
  const markerStart = quoteLen + leadChars
  const markerLen = kind === 'ordered' ? digits.length + delim.length : bullet.length
  const markerEnd = markerStart + markerLen
  const spaceEnd = markerEnd + spaces.length
  const contentOffset = spaceEnd + box.length
  const markerWidth = markerLen + expandIndent(spaces, lead + markerLen)
  const isEmpty = text.slice(contentOffset).trim() === ''
  return {
    quotePrefix,
    quoteLen,
    quoteDepth: countQuotes(quotePrefix),
    leadChars,
    lead,
    kind,
    digits,
    delim,
    bullet,
    markerStart,
    markerEnd,
    spaceEnd,
    markerWidth,
    box,
    contentOffset,
    isEmpty,
  }
}

const frontmatterEndCache = new WeakMap<Text, number>()

/** 文档头 YAML 属性区的字符结束偏移（不含末尾换行），无属性区时返回 -1。按 Text 实例缓存。 */
export function frontmatterEnd(doc: Text): number {
  const cached = frontmatterEndCache.get(doc)
  if (cached !== undefined) return cached
  let result = -1
  if (doc.lines >= 2 && doc.line(1).text.trimEnd() === '---') {
    // 只切片前几 KB 检查属性区，避免对超长文档整篇 toString()
    const cap = Math.min(doc.length, 32768)
    const range = frontmatterRange(doc.sliceString(0, cap))
    result = range ? range.to : -1
  }
  frontmatterEndCache.set(doc, result)
  return result
}

/**
 * 某一行在渲染模式下是否属于「受保护的有序列表行」（供原子区间与光标守护共用）：
 *   · 排除围栏代码/HTML/表格/属性区；
 *   · 要么语法树已经将其前缀识别为 `ListMark`（真正的有序列表项），
 *     要么是刚敲完尚未打字的空有序项（如紧跟普通段落下的 `1. `）。
 * 这样普通折行段落里的 `2026. 敬请期待`、多行行内代码、块公式内的 `2. x` 绝不会被误锁。
 */
export function isActiveOrderedListLine(
  doc: Text,
  tree: Tree,
  lineNumber: number,
  fmEnd?: number,
): ParsedListLine | null {
  if (isExcludedLine(doc, tree, lineNumber, fmEnd)) return null
  const line = doc.line(lineNumber)
  const parsed = parseListLine(line.text)
  if (!parsed || parsed.kind !== 'ordered') return null
  const markFrom = line.from + parsed.markerStart
  const inner = tree.resolveInner(Math.min(markFrom, tree.length), 1)
  if (inner.name === 'ListMark') return parsed
  if (parsed.isEmpty && !parsed.box && inner.name === 'Paragraph') return parsed
  return null
}

const EXCLUDED_NODES = new Set(['FencedCode', 'HTMLBlock', 'Table', 'CommentBlock'])

/**
 * 某一行是否落在真正的非列表块（属性区、围栏代码、HTML 块、表格）内。
 * 注意不排除 `CodeBlock`（缩进代码块），以免合法的深层缩进列表项被误杀。
 */
export function isExcludedLine(
  doc: Text,
  tree: Tree | null,
  lineNumber: number,
  fmEnd?: number,
): boolean {
  const line = doc.line(lineNumber)
  const endOfFm = fmEnd ?? frontmatterEnd(doc)
  if (endOfFm >= 0 && line.from <= endOfFm) return true
  if (!tree) return false
  const probe = Math.min(line.to, line.from + (QUOTE_PREFIX_RE.exec(line.text)?.[0].length ?? 0))
  let node: SyntaxNode | null = tree.resolveInner(Math.min(probe, tree.length), 1)
  while (node) {
    if (EXCLUDED_NODES.has(node.name)) return true
    node = node.parent
  }
  return false
}

/** 剥掉引用前缀后，这一行是不是空行。 */
export function isBlankAfterQuote(text: string): boolean {
  return text.replace(QUOTE_PREFIX_RE, '').trim() === ''
}

/**
 * 以某一行号为锚点，扫出它所属的「连续非空列表块」。
 *
 * 规则：隔空行、换引用层、遇到顶格非列表行或顶格排除块，块立刻结束。
 * 缩进在列表项内的排除块（如列表项内嵌围栏代码块）作为缩进内容保留块连续性，
 * 但绝不把其中的行当成列表项解析。
 * 返回 null 表示该行不在任何列表块中。
 */
export function scanListBlock(
  doc: Text,
  anchorLine: number,
  tree: Tree | null,
  fmEnd?: number,
  excludedFn?: (lineNumber: number) => boolean,
): ListBlock | null {
  if (anchorLine < 1 || anchorLine > doc.lines) return null
  const endOfFm = fmEnd ?? frontmatterEnd(doc)
  const checkExcluded = excludedFn ?? ((n: number) => isExcludedLine(doc, tree, n, endOfFm))
  if (checkExcluded(anchorLine)) return null

  const anchor = doc.line(anchorLine)
  const anchorQuotePrefix = QUOTE_PREFIX_RE.exec(anchor.text)?.[0] ?? ''
  const quoteDepth = countQuotes(anchorQuotePrefix)
  if (isBlankAfterQuote(anchor.text)) return null

  const parsedCache = new Map<number, ParsedListLine | null>()
  const excludedCache = new Map<number, boolean>()

  const getExcluded = (n: number): boolean => {
    let hit = excludedCache.get(n)
    if (hit === undefined) {
      hit = checkExcluded(n)
      excludedCache.set(n, hit)
    }
    return hit
  }

  const getParsed = (n: number, text: string): ParsedListLine | null => {
    let hit = parsedCache.get(n)
    if (hit === undefined) {
      hit = parseListLine(text)
      parsedCache.set(n, hit)
    }
    return hit
  }

  const belongsToCluster = (n: number): 'list' | 'indented' | 'stop' => {
    if (n < 1 || n > doc.lines) return 'stop'
    const text = doc.line(n).text
    const qp = QUOTE_PREFIX_RE.exec(text)?.[0] ?? ''
    if (countQuotes(qp) !== quoteDepth) return 'stop'
    const rest = text.slice(qp.length)
    if (rest.trim() === '') return 'stop'
    if (getExcluded(n)) {
      // 缩进在列表项内的围栏代码块/表格保留块连续性（归作缩进内容），顶格排除块截断列表
      return /^[ \t]/.test(rest) ? 'indented' : 'stop'
    }
    if (getParsed(n, text)) return 'list'
    if (/^[ \t]/.test(rest)) return 'indented'
    return 'stop'
  }

  const anchorKind = belongsToCluster(anchorLine)
  if (anchorKind === 'stop') return null

  // 向上扩到连续块起点
  let start = anchorLine
  let seenListAbove = anchorKind === 'list'
  let topListLine = anchorKind === 'list' ? anchorLine : -1
  for (let n = anchorLine - 1; n >= Math.max(1, anchorLine - MAX_BLOCK_LINES); n--) {
    const k = belongsToCluster(n)
    if (k === 'stop') break
    start = n
    if (k === 'list') {
      seenListAbove = true
      topListLine = n
    }
  }
  // 块顶部的纯缩进普通行（上方没有列表项）不是列表续行，裁掉
  if (!seenListAbove) return null
  if (topListLine > start) start = topListLine

  // 向下扩到连续块终点
  let end = anchorLine
  for (let n = anchorLine + 1; n <= Math.min(doc.lines, start + MAX_BLOCK_LINES); n++) {
    const k = belongsToCluster(n)
    if (k === 'stop') break
    end = n
  }

  return buildListBlock(doc, start, end, quoteDepth, getExcluded, getParsed)
}

const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})/

function buildListBlock(
  doc: Text,
  startLine: number,
  endLine: number,
  quoteDepth: number,
  getExcluded: (n: number) => boolean,
  getParsed: (n: number, text: string) => ParsedListLine | null,
): ListBlock | null {
  const items: BlockItem[] = []
  const itemIndexByLine = new Map<number, number>()
  const orderedGroups: OrderedGroup[] = []
  const orderedGroupMap = new Map<number, OrderedGroup>()

  interface Frame {
    item: BlockItem
  }
  const stack: Frame[] = []
  // 每个父层级（null 表示顶层）上最近一条兄弟项，用来判断同级分组是否连续
  const lastSiblingByParent = new Map<number | null, BlockItem>()
  let nextGroupId = 1
  // 轻量围栏追踪：即使在事务过滤阶段尚无新语法树，也绝不穿透块内新建的围栏代码块
  let activeFence: { ch: string; len: number } | null = null

  for (let n = startLine; n <= endLine; n++) {
    const line = doc.line(n)
    const qpLen = QUOTE_PREFIX_RE.exec(line.text)?.[0].length ?? 0
    const body = line.text.slice(qpLen)

    if (activeFence) {
      const trimmed = body.trim()
      if (
        trimmed.length >= activeFence.len &&
        trimmed[0] === activeFence.ch &&
        /^[`~]+$/.test(trimmed) &&
        trimmed.split('').every((c) => c === activeFence!.ch)
      ) {
        activeFence = null
      }
      continue
    }

    const fenceMatch = FENCE_OPEN_RE.exec(body)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      // CommonMark：反引号围栏的 info string 不能包含反引号
      const afterMarker = body.slice(fenceMatch[0].length)
      if (marker[0] !== '`' || !afterMarker.includes('`')) {
        activeFence = { ch: marker[0], len: marker.length }
        continue
      }
    }

    if (getExcluded(n)) continue

    const parsed = getParsed(n, line.text)
    if (!parsed) continue

    // 弹出所有不能当当前项父级的祖先：
    // 子项必须比父项严格多出至少 2 列缩进（避免手误多敲 1 空格误判成子级，
    // 同时兼容旧 3 空格子项在父项从 9. 涨成 10. 时仍保持父子关系）。
    while (stack.length > 0) {
      const top = stack[stack.length - 1].item
      if (parsed.lead >= top.parsed.lead + 2) break
      stack.pop()
    }

    const parent = stack.length > 0 ? stack[stack.length - 1].item : null
    const parentLine = parent ? parent.lineNumber : null
    const depth = stack.length

    const prevSib = lastSiblingByParent.get(parentLine)
    let groupId: number
    if (
      prevSib &&
      prevSib.parsed.kind === parsed.kind &&
      prevSib.parsed.delim === parsed.delim &&
      // 同一同级组缩进必须相容（允许 1 列容错，绝不把失去父项的 4 空格孤立子项和下方 0 空格项并组）
      Math.abs(prevSib.parsed.lead - parsed.lead) <= 1
    ) {
      groupId = prevSib.groupId
    } else {
      groupId = nextGroupId++
    }

    const item: BlockItem = {
      lineNumber: n,
      lineFrom: line.from,
      lineTo: line.to,
      parsed,
      depth,
      parentLine,
      groupId,
      subtreeEndLine: n,
    }

    itemIndexByLine.set(n, items.length)
    items.push(item)
    lastSiblingByParent.set(parentLine, item)
    // 开启了新的同级项，清理所有比它深的层级映射，以免更深层级跨父项串组
    for (const [key] of lastSiblingByParent) {
      if (key !== null && key !== parentLine) {
        const keyIdx = itemIndexByLine.get(key)
        const keyItem = keyIdx !== undefined ? items[keyIdx] : undefined
        if (keyItem && keyItem.depth >= depth) lastSiblingByParent.delete(key)
      }
    }

    if (parsed.kind === 'ordered') {
      let group = orderedGroupMap.get(groupId)
      if (!group) {
        group = {
          id: groupId,
          parentLine,
          depth,
          delim: parsed.delim as '.' | ')',
          items: [],
        }
        orderedGroupMap.set(groupId, group)
        orderedGroups.push(group)
      }
      group.items.push(item)
    }

    stack.push({ item })
  }

  if (items.length === 0) return null

  // 用单调栈 O(N) 计算每项名下的整棵子树终止行（包含子孙项和末尾缩进续行）
  const endStack: BlockItem[] = []
  for (let i = 0; i < items.length; i++) {
    const cur = items[i]
    while (endStack.length > 0 && endStack[endStack.length - 1].depth >= cur.depth) {
      const closed = endStack.pop()!
      closed.subtreeEndLine = Math.max(closed.lineNumber, cur.lineNumber - 1)
    }
    endStack.push(cur)
  }
  while (endStack.length > 0) {
    const closed = endStack.pop()!
    closed.subtreeEndLine = Math.max(closed.lineNumber, endLine)
  }

  return { startLine, endLine, quoteDepth, items, orderedGroups, itemIndexByLine }
}

/** 找同一连续块内、同父层级、同类型的上一条兄弟项。 */
export function findPrevSibling(block: ListBlock, lineNumber: number): BlockItem | null {
  const idx = block.itemIndexByLine.get(lineNumber)
  if (idx === undefined || idx <= 0) return null
  const self = block.items[idx]
  for (let i = idx - 1; i >= 0; i--) {
    const prev = block.items[i]
    if (prev.depth < self.depth) return null
    if (prev.depth === self.depth && prev.parentLine === self.parentLine) {
      return prev.groupId === self.groupId ? prev : null
    }
  }
  return null
}

/** 找当前项下方紧跟的直接子列表第一项（无直接子项时返回 null）。 */
export function findFirstDirectChild(block: ListBlock, lineNumber: number): BlockItem | null {
  const idx = block.itemIndexByLine.get(lineNumber)
  if (idx === undefined || idx + 1 >= block.items.length) return null
  const self = block.items[idx]
  const next = block.items[idx + 1]
  return next.parentLine === self.lineNumber ? next : null
}

/** 找同一连续块里在当前行之前的最近一条缩进 <= maxLead 的列表项（用作 Tab 缩进时的父项）。 */
export function findIndentParent(
  block: ListBlock,
  lineNumber: number,
  maxLead: number,
): BlockItem | null {
  const idx = block.itemIndexByLine.get(lineNumber)
  if (idx === undefined || idx <= 0) return null
  for (let i = idx - 1; i >= 0; i--) {
    const prev = block.items[i]
    if (prev.parsed.lead <= maxLead) return prev
  }
  return null
}

/** 找当前项的上一级父项（用于 Shift+Tab 退缩进）。 */
export function findOutdentTarget(block: ListBlock, lineNumber: number): BlockItem | null {
  const idx = block.itemIndexByLine.get(lineNumber)
  if (idx === undefined) return null
  const self = block.items[idx]
  for (let i = idx - 1; i >= 0; i--) {
    const prev = block.items[i]
    if (prev.parsed.lead < self.parsed.lead) return prev
  }
  return null
}
