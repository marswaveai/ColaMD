import { nativeImage } from 'electron'
import { basename, dirname, extname, isAbsolute, resolve } from 'path'
import { fileURLToPath } from 'url'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import {
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
      runs.push(new TextRun({ text: node.value ?? '', font: 'Menlo', shading: { fill: 'F1F3F5' } }))
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

function imageParagraph(node: MarkdownNode, sourcePath: string | null): Paragraph {
  const path = node.url ? imagePath(node.url, sourcePath) : null
  if (!path) return new Paragraph({ children: [new TextRun({ text: node.alt ? `[${node.alt}]` : '[image]', italics: true })] })

  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) return new Paragraph({ children: [new TextRun({ text: node.alt ? `[${node.alt}]` : '[image]', italics: true })] })

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

function blockNodes(nodes: MarkdownNode[] | undefined, sourcePath: string | null, listDepth = 0): Array<Paragraph | Table> {
  if (!nodes) return []
  const output: Array<Paragraph | Table> = []
  for (const node of nodes) {
    if (node.type === 'heading') {
      output.push(new Paragraph({ heading: headingForDepth(node.depth ?? 1), children: inlineRuns(node.children) }))
    } else if (node.type === 'paragraph') {
      const image = node.children?.length === 1 && node.children[0]?.type === 'image' ? node.children[0] : null
      output.push(image ? imageParagraph(image, sourcePath) : new Paragraph({ children: inlineRuns(node.children), spacing: { after: 120 } }))
    } else if (node.type === 'image') {
      output.push(imageParagraph(node, sourcePath))
    } else if (node.type === 'blockquote') {
      output.push(new Paragraph({
        children: [new TextRun({ text: textContent(node), italics: true })],
        indent: { left: 720 },
        border: { left: { color: 'AEB7C2', space: 8, style: 'single', size: 12 } },
      }))
    } else if (node.type === 'code') {
      output.push(new Paragraph({
        children: [new TextRun({ text: node.value ?? '', font: 'Menlo', size: 18 })],
        shading: { fill: 'F1F3F5' },
        spacing: { before: 120, after: 120 },
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
        output.push(...blockNodes(item.children?.filter((child) => child !== first), sourcePath, listDepth + 1))
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
      output.push(...blockNodes(node.children, sourcePath, listDepth))
    }
  }
  return output
}

export async function markdownToDocx(input: DocxExportInput): Promise<Buffer> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(input.content) as MarkdownNode
  const document = new Document({
    creator: 'ColaMD',
    title: input.sourcePath ? basename(input.sourcePath, extname(input.sourcePath)) : 'Untitled',
    sections: [{ children: blockNodes(tree.children, input.sourcePath) }],
  })
  return Packer.toBuffer(document)
}
