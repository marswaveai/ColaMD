import { nativeImage } from 'electron'
import { basename, dirname, extname, isAbsolute, resolve } from 'path'
import { fileURLToPath } from 'url'
// 这三个必须在 package.json 里**直接声明**。
// 曾经它们只是 @milkdown/* 的传递依赖，靠 npm 的依赖提升侥幸能 load：构建期发现不了
// （主进程的依赖是外部化的，vite 不解析它们），一执行 npm install 删掉 milkdown，
// Word 导出就会在运行时「模块找不到」（2026-10-06 换内核后的清理里查出来的）。
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx'

interface MarkdownNode {
  type: string
  value?: string
  depth?: number
  ordered?: boolean
  start?: number
  url?: string
  alt?: string
  children?: MarkdownNode[]
}

export interface DocxExportInput {
  content: string
  sourcePath: string | null
  // Diagrams the renderer drew for this export, keyed by the name the rewritten
  // Markdown points at (`![示意图](colamd-diagram-1.png)`). They arrive as PNG
  // data URLs because they exist only in memory.
  images?: Record<string, string>
}

/**
 * 代码用的字体。
 *
 * 以前写死 `font: 'Menlo'`：Menlo 是 macOS 的字体，Windows 上没有。docx 会把这个
 * 字符串同时写进 `w:rFonts` 的 ascii / hAnsi / cs / eastAsia 四个槽位，Word 找不到
 * 字体就整段替换，代码块在 Windows 上直接变成 ♣ ○ ◇ 这种符号乱码（#202 报的）。
 * eastAsia 单独给一个中文字体，代码里的中文注释才不会是乱码里混着方框。
 */
const CODE_FONT = process.platform === 'darwin'
  ? { ascii: 'Menlo', hAnsi: 'Menlo', cs: 'Menlo', eastAsia: 'PingFang SC' }
  : process.platform === 'win32'
    ? { ascii: 'Consolas', hAnsi: 'Consolas', cs: 'Consolas', eastAsia: 'Microsoft YaHei' }
    : { ascii: 'DejaVu Sans Mono', hAnsi: 'DejaVu Sans Mono', cs: 'DejaVu Sans Mono', eastAsia: 'Noto Sans CJK SC' }

const CODE_SIZE = 18

/**
 * 代码块的每一行都要自己一个 run，行间用 `<w:br/>`。
 *
 * OOXML 里 `<w:t>` 内部的 `\n` 不产生换行，把整段代码塞进一个 TextRun，导出后只会
 * 剩下 Word 的自动折行（#202 的第 2 条）。空行也要留一个 break，不然空行会被吃掉。
 */
function codeRuns(value: string): ParagraphChild[] {
  const lines = value.replace(/\n+$/, '').split('\n')
  const runs: ParagraphChild[] = []
  lines.forEach((line, index) => {
    if (index > 0) runs.push(new TextRun({ break: 1, font: CODE_FONT, size: CODE_SIZE }))
    if (line !== '') runs.push(new TextRun({ text: line, font: CODE_FONT, size: CODE_SIZE, noProof: true }))
  })
  return runs.length > 0 ? runs : [new TextRun({ text: '', font: CODE_FONT, size: CODE_SIZE })]
}

function headingForDepth(depth: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  const headings = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ]
  return headings[Math.max(0, Math.min(5, depth - 1))] as (typeof HeadingLevel)[keyof typeof HeadingLevel]
}

function textContent(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') return node.value ?? ''
  if (node.type === 'break') return '\n'
  return node.children?.map(textContent).join('') ?? ''
}

function inlineRuns(nodes: MarkdownNode[] | undefined, style: { bold?: boolean; italics?: boolean; strike?: boolean } = {}): ParagraphChild[] {
  if (!nodes) return []
  const runs: ParagraphChild[] = []
  for (const node of nodes) {
    if (node.type === 'text') {
      runs.push(new TextRun({ text: node.value ?? '', ...style }))
    } else if (node.type === 'break') {
      runs.push(new TextRun({ break: 1, ...style }))
    } else if (node.type === 'inlineCode') {
      runs.push(new TextRun({ text: node.value ?? '', font: CODE_FONT, size: CODE_SIZE, shading: { fill: 'F1F3F5' }, noProof: true }))
    } else if (node.type === 'strong') {
      runs.push(...inlineRuns(node.children, { ...style, bold: true }))
    } else if (node.type === 'emphasis') {
      runs.push(...inlineRuns(node.children, { ...style, italics: true }))
    } else if (node.type === 'delete') {
      runs.push(...inlineRuns(node.children, { ...style, strike: true }))
    } else if (node.type === 'link' && node.url) {
      runs.push(new ExternalHyperlink({ link: node.url, children: inlineRuns(node.children, style) }))
    } else if (node.type === 'image') {
      runs.push(new TextRun({ text: node.alt ? `[${node.alt}]` : '[image]', italics: true }))
    } else {
      runs.push(...inlineRuns(node.children, style))
    }
  }
  return runs
}

function imagePath(url: string, sourcePath: string | null): string | null {
  if (/^(https?:|data:|blob:)/i.test(url)) return null
  try {
    if (url.startsWith('file:')) return fileURLToPath(url)
  } catch {
    return null
  }
  if (!sourcePath) return null
  return isAbsolute(url) ? url : resolve(dirname(sourcePath), decodeURIComponent(url))
}

function imageParagraph(node: MarkdownNode, sourcePath: string | null, images: Record<string, string> | undefined): Paragraph {
  const dataURL = node.url && images ? images[node.url] : undefined
  const image = dataURL
    ? nativeImage.createFromDataURL(dataURL)
    : (() => {
        const path = node.url ? imagePath(node.url, sourcePath) : null
        return path ? nativeImage.createFromPath(path) : null
      })()
  if (!image || image.isEmpty()) return new Paragraph({ children: [new TextRun({ text: node.alt ? `[${node.alt}]` : '[image]', italics: true })] })

  const size = image.getSize()
  const scale = Math.min(1, 560 / size.width, 420 / size.height)
  return new Paragraph({
    children: [new ImageRun({
      type: 'png',
      data: image.toPNG(),
      transformation: { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) },
    })],
  })
}

function tableForNode(node: MarkdownNode): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: (node.children ?? []).map((row) => new TableRow({
      children: (row.children ?? []).map((cell) => new TableCell({
        children: [new Paragraph({ children: inlineRuns(cell.children) })],
      })),
    })),
  })
}

function blockNodes(nodes: MarkdownNode[] | undefined, sourcePath: string | null, images?: Record<string, string>, listDepth = 0): Array<Paragraph | Table> {
  if (!nodes) return []
  const output: Array<Paragraph | Table> = []
  for (const node of nodes) {
    if (node.type === 'heading') {
      output.push(new Paragraph({ heading: headingForDepth(node.depth ?? 1), children: inlineRuns(node.children) }))
    } else if (node.type === 'paragraph') {
      const image = node.children?.length === 1 && node.children[0]?.type === 'image' ? node.children[0] : null
      output.push(image ? imageParagraph(image, sourcePath, images) : new Paragraph({ children: inlineRuns(node.children), spacing: { after: 120 } }))
    } else if (node.type === 'image') {
      output.push(imageParagraph(node, sourcePath, images))
    } else if (node.type === 'blockquote') {
      // 引用里的多段各占一段、段间用 `<w:br/>`（以前整块 textContent 拼成一段，
      // 段与段之间只剩自动折行）
      const quoteRuns: ParagraphChild[] = []
      for (const child of (node.children ?? []).filter((c) => c.type !== 'blockquote')) {
        if (quoteRuns.length > 0) quoteRuns.push(new TextRun({ break: 1 }))
        quoteRuns.push(...inlineRuns(child.children ?? [], { italics: true }))
      }
      output.push(new Paragraph({
        children: quoteRuns.length > 0 ? quoteRuns : [new TextRun({ text: textContent(node), italics: true })],
        indent: { left: 720 },
        border: { left: { color: 'AEB7C2', space: 8, style: 'single', size: 12 } },
      }))
    } else if (node.type === 'code') {
      // 显式左对齐：不写的话继承默认样式，默认是两端对齐时每一行都会被拉满行宽，
      // 键留在左边、值被顶到右边（#202 的第 3 条）。
      output.push(new Paragraph({
        children: codeRuns(node.value ?? ''),
        alignment: AlignmentType.LEFT,
        shading: { fill: 'F6F7F9' },
        spacing: { before: 120, after: 120, line: 240 },
        border: {
          top: { color: 'E3E8EE', space: 4, style: 'single', size: 4 },
          bottom: { color: 'E3E8EE', space: 4, style: 'single', size: 4 },
          left: { color: 'E3E8EE', space: 4, style: 'single', size: 4 },
          right: { color: 'E3E8EE', space: 4, style: 'single', size: 4 },
        },
      }))
    } else if (node.type === 'list') {
      const start = node.start ?? 1
      for (const [index, item] of (node.children ?? []).entries()) {
        const first = item.children?.find((child) => child.type === 'paragraph')
        const prefix = node.ordered ? `${start + index}. ` : '• '
        output.push(new Paragraph({
          children: [new TextRun({ text: prefix }), ...inlineRuns(first?.children)],
          indent: { left: 360 + listDepth * 360, hanging: 240 },
          spacing: { after: 60 },
        }))
        output.push(...blockNodes(item.children?.filter((child) => child !== first), sourcePath, images, listDepth + 1))
      }
    } else if (node.type === 'table') {
      output.push(tableForNode(node))
    } else if (node.type === 'thematicBreak') {
      output.push(new Paragraph({ border: { bottom: { color: 'AEB7C2', space: 1, style: 'single', size: 6 } } }))
    } else if (node.type === 'html') {
      output.push(new Paragraph({ children: [new TextRun({ text: node.value ?? '' })] }))
    } else if (node.type === 'footnoteDefinition') {
      output.push(new Paragraph({ children: [new TextRun({ text: textContent(node), size: 18, color: '667085' })] }))
    } else {
      output.push(...blockNodes(node.children, sourcePath, images, listDepth))
    }
  }
  return output
}

export async function markdownToDocx(input: DocxExportInput): Promise<Buffer> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(input.content) as MarkdownNode
  const document = new Document({
    creator: 'ColaMD',
    title: input.sourcePath ? basename(input.sourcePath, extname(input.sourcePath)) : 'Untitled',
    sections: [{ children: blockNodes(tree.children, input.sourcePath, input.images) }],
  })
  return Packer.toBuffer(document)
}
