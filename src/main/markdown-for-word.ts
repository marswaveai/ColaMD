import { parser } from '@lezer/markdown'
// 解析依赖必须直接声明，不能依赖别的编辑器包将它们提升到 node_modules 根目录。
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { tableMarkdown } from '../shared/markdown-tables'

export interface MarkdownNode {
  type: string
  value?: string
  depth?: number
  ordered?: boolean
  start?: number
  url?: string
  alt?: string
  children?: MarkdownNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

const tableParser = parser.configure(tableMarkdown)
const wordParser = unified().use(remarkParse).use(remarkGfm)

function offsetNode(node: MarkdownNode, offset: number): void {
  if (node.position) node.position = {
    start: { offset: (node.position.start.offset ?? 0) + offset },
    end: { offset: (node.position.end.offset ?? 0) + offset },
  }
  node.children?.forEach(child => offsetNode(child, offset))
}

/** 普通前缀保持行内语义；骨架同时提供容器和定义上下文，remark 只解析一次。 */
function cellInlines(content: string, context: string, cells: { from: number; to: number }[]): MarkdownNode {
  const offsets: number[] = []
  let length = 0
  const source = cells.map(({ from, to }) => {
    offsets.push(from - length - 2)
    const paragraph = 'x ' + content.slice(from, to) + '\n\n'
    length += paragraph.length
    return paragraph
  }).join('')
  const parsed = wordParser.parse(source + context) as MarkdownNode
  const inlines = new Map<number, MarkdownNode[]>()
  cells.forEach(({ from }, index) => {
    const nodes = parsed.children?.[index]?.children ?? []
    if (nodes[0]?.type === 'text') {
      nodes[0].value = nodes[0].value?.slice(2)
      if (nodes[0].position?.start.offset !== undefined) nodes[0].position.start.offset += 2
      if (!nodes[0].value) nodes.shift()
    }
    nodes.forEach(node => offsetNode(node, offsets[index]))
    inlines.set(from, nodes)
  })
  const tree: MarkdownNode = { type: 'root', children: parsed.children?.slice(cells.length), position: { start: { offset: 0 }, end: { offset: content.length } } }
  tree.children?.forEach(node => offsetNode(node, -length))
  const restore = (node: MarkdownNode) => {
    if (node.type === 'tableCell') {
      let from = node.position!.start.offset!
      if (context[from] === '|') from++
      while (/[ \t]/.test(context[from] ?? '')) from++
      const children = inlines.get(from)
      if (children) node.children = children
    } else node.children?.forEach(restore)
  }
  restore(tree)
  return tree
}

/**
 * 共享解析器决定格线；等长骨架仅让 remark 保留列表、引用和表格容器。
 * 每格随后解析原始行内内容，代码、链接地址和 HTML 属性不会经历第二次分格。
 */
export function parseMarkdownForWord(content: string): MarkdownNode {
  if (!content.includes('|')) return wordParser.parse(content) as MarkdownNode
  const cells: { from: number; to: number }[] = []
  const pieces: string[] = []
  let copied = 0
  // 与编辑器一样按 LF 解析；记录 CRLF 少掉的位置，将格边界映回原文。
  const crlf: number[] = []
  const lines = content.replace(/\r\n?/g, (newline, at: number) => {
    if (newline.length === 2) crlf.push(at - crlf.length)
    return '\n'
  })
  const sourceOffset = (pos: number) => {
    let left = 0, right = crlf.length
    while (left < right) {
      const mid = (left + right) >>> 1
      if (crlf[mid] < pos) left = mid + 1
      else right = mid
    }
    return pos + left
  }
  tableParser.parse(lines).iterate({ enter(node) {
    if (node.name !== 'TableCell') return
    const from = sourceOffset(node.from), to = sourceOffset(node.to)
    cells.push({ from, to })
    pieces.push(content.slice(copied, from), content.slice(from, to).replace(/[^\r\n]/g, 'x'))
    copied = to
    return false
  } })
  if (!cells.length) return wordParser.parse(content) as MarkdownNode
  return cellInlines(content, pieces.join('') + content.slice(copied), cells)
}
