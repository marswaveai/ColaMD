/*!
 * Table leaf lifecycle adapted from @lezer/markdown, MIT License.
 * Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin> and others
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { Autolink, Strikethrough, Table, TaskList, type BlockContext, type Element, type LeafBlock, type LeafBlockParser, type Line, type MarkdownConfig } from '@lezer/markdown'

export interface CodeSpan { from: number; to: number }

/**
 * 表格先保护完整代码跨度，再分格。等长反引号配对；未闭合、被转义的起点不保护。
 * 先索引各段反引号的下一个等长段，避免未闭合反引号反复扫描整行。
 */
export function tableCodeSpans(text: string): CodeSpan[] {
  const runs: { from: number; to: number; escaped: boolean; next?: number }[] = []
  let slashes = 0
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\') { slashes++; i++; continue }
    if (text[i] !== '`') { slashes = 0; i++; continue }
    const from = i++
    while (text[i] === '`') i++
    runs.push({ from, to: i, escaped: slashes % 2 === 1 })
    slashes = 0
  }
  const next = new Map<number, number>()
  for (let i = runs.length - 1; i >= 0; i--) {
    const size = runs[i].to - runs[i].from
    runs[i].next = next.get(size)
    next.set(size, i)
  }
  const spans: CodeSpan[] = []
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    if (run.escaped || run.next === undefined) continue
    spans.push({ from: run.from, to: runs[run.next].to })
    i = run.next
  }
  return spans
}

/** 只有代码外且未转义的竖线才是分格符。偏移相对原文，绝不改写待解析文本。 */
export function tablePipes(text: string, start = 0): number[] {
  const spans = text.includes('`') ? tableCodeSpans(text.slice(start)) : []
  const pipes: number[] = []
  let span = 0
  for (let i = start; i < text.length; i++) {
    if (spans[span]?.from === i - start) { i = start + spans[span++].to - 1; continue }
    if (text[i] === '\\') i++
    else if (text[i] === '|') pipes.push(i)
  }
  return pipes
}

/** 格子原有的未配对反引号是字面文字，必要时转义它，防止与隔壁格子配对。 */
export function unpairedBackticks(text: string): number[] {
  const spans = tableCodeSpans(text)
  const positions: number[] = []
  let span = 0
  for (let i = 0; i < text.length; i++) {
    if (spans[span]?.from === i) { i = spans[span++].to - 1; continue }
    if (text[i] === '\\') { i++; continue }
    if (text[i] !== '`') continue
    positions.push(i)
    while (text[i + 1] === '`') i++
  }
  return positions
}

function parseRow(cx: BlockContext, text: string, start = 0, offset = 0): { cells: number; elements: Element[] } {
  const pipes = tablePipes(text, start)
  const elements: Element[] = []
  let cells = 0, from = start
  const addCell = (to: number, interior: boolean) => {
    let left = from, right = to
    while (left < right && /[ \t]/.test(text[left])) left++
    while (right > left && /[ \t]/.test(text[right - 1])) right--
    if (interior || left < right) cells++
    if (left < right) elements.push(cx.elt('TableCell', offset + left, offset + right,
      cx.parser.parseInline(text.slice(left, right), offset + left)))
  }
  for (let i = 0; i < pipes.length; i++) {
    addCell(pipes[i], i > 0)
    elements.push(cx.elt('TableDelimiter', offset + pipes[i], offset + pipes[i] + 1))
    from = pipes[i] + 1
  }
  addCell(text.length, false)
  return { cells, elements }
}

// 生命周期沿用 @lezer/markdown 的 Table 扩展（MIT）；只替换分格规则。
// 使用公开 leaf API，保留引用/列表的容器位置及增量解析。
const delimiterLine = /^[>\s]*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/
class CodeTableParser implements LeafBlockParser {
  private rows: Element[] | null | false = null

  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    if (this.rows === null) {
      this.rows = false
      const text = line.text.slice(line.pos)
      if ((line.next === 45 || line.next === 58 || line.next === 124) && delimiterLine.test(text)) {
        const header = parseRow(cx, leaf.content, 0, leaf.start)
        if (header.cells === parseRow(cx, text).cells) this.rows = [
          cx.elt('TableHeader', leaf.start, leaf.start + leaf.content.length, header.elements),
          cx.elt('TableDelimiter', cx.lineStart + line.pos, cx.lineStart + line.text.length),
        ]
      }
    } else if (this.rows) {
      this.rows.push(cx.elt('TableRow', cx.lineStart + line.pos, cx.lineStart + line.text.length,
        parseRow(cx, line.text, line.pos, cx.lineStart).elements))
    }
    return false
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    if (!this.rows) return false
    cx.addLeafElement(leaf, cx.elt('Table', leaf.start, leaf.start + leaf.content.length, this.rows))
    return true
  }
}

const codeTables: MarkdownConfig = {
  defineNodes: Table.defineNodes,
  parseBlock: [{
    name: 'Table',
    before: 'SetextHeading',
    leaf: (_cx, leaf) => tablePipes(leaf.content).length ? new CodeTableParser() : null,
    endLeaf(cx, line, leaf) {
      if (leaf.parsers.some(parser => parser instanceof CodeTableParser) || !tablePipes(line.text, line.basePos).length) return false
      const next = cx.peekLine()
      return delimiterLine.test(next) && parseRow(cx, line.text, line.basePos).cells === parseRow(cx, next, line.basePos).cells
    },
  }],
}

/** GFM 的其他扩展照旧；仅表格采用代码范围内保留原文的规则。 */
export const tableMarkdown = [codeTables, TaskList, Strikethrough, Autolink]
