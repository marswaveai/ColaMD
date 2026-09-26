// 把编辑器画出来的 DOM 翻译成一篇干净的 HTML。
//
// 编辑器里的 DOM 是给**编辑**用的：每一行是一个 `<div class="cm-line">`，加粗是
// `<span class="cm-md-strong">`。这套结构只在我们自己的 CSS 下才成立，拿到别处就散架：
// 复制到微信、Word 里加粗不再是加粗，而每个 div 还会被当成一个段落，凭空多出一堆空行。
//
// 所以这里做一次翻译：行 → `<p>`，连续的同类行合并成 `<ul>`/`<ol>`/`<blockquote>`/`<pre>`，
// 装饰类 → 语义标签。**只读**：它不改编辑器里的任何东西，改的是要交出去的那份拷贝。

/** 元素上的装饰类 → 语义标签。没登记的类原样透传（KaTeX、mermaid、图片要保住）。 */
const INLINE_TAGS: Record<string, string> = {
  'cm-md-strong': 'strong',
  'cm-md-em': 'em',
  'cm-md-strike': 's',
  'cm-md-inlinecode': 'code',
  'cm-md-highlight': 'mark',
}

/** 这些是编辑器自己的零件，交出去的文档里不该出现。 */
const DROP_CLASSES = new Set([
  'cm-widgetBuffer',
  'cm-md-li-bullet',
  'cm-md-listmark',
  'cm-md-quotemark',
  'code-copy-btn',
  'cm-md-jump-flash',
  // 光标所在的那一行会把 markdown 标记（`**`、`#`、`==` 等）露出来给人看，
  // 它们不属于正文，交出去的那份里不能带
  'cm-md-marker',
])

type LineKind = 'code' | 'li' | 'quote' | 'hr' | 'table' | 'empty' | 'p' | `h${1 | 2 | 3 | 4 | 5 | 6}`

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

function lineKind(line: HTMLElement): LineKind {
  const classes = line.classList
  for (let level = 1; level <= 6; level++) {
    if (classes.contains(`cm-md-atxheading${level}`)) return `h${level}` as LineKind
  }
  if (classes.contains('cm-md-codeblock')) return 'code'
  if (classes.contains('cm-md-blockquote')) return 'quote'
  if (classes.contains('cm-md-hr')) return 'hr'
  if (line.querySelector('.cm-md-table-widget')) return 'table'
  if (classes.contains('cm-md-frontmatter')) return 'empty'
  for (let depth = 0; depth <= 6; depth++) {
    if (classes.contains(`cm-md-li-${depth}`)) return 'li'
  }
  if ((line.textContent ?? '').trim() === '' && line.querySelector('img') === null) return 'empty'
  return 'p'
}

/** 列表项在源码里的层级（`cm-md-li-N` 的 N）。 */
function listDepth(line: HTMLElement): number {
  for (let depth = 6; depth >= 0; depth--) {
    if (line.classList.contains(`cm-md-li-${depth}`)) return depth
  }
  return 0
}

/** 这一行是不是有序列表（`1.` 这种序号是用户写的，会留在行里）。 */
function isOrdered(line: HTMLElement): boolean {
  const mark = line.querySelector('.cm-md-listmark')
  return !!mark && /^\s*\d+[.)]/.test(mark.textContent ?? '')
}

function inlineHTML(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '')
  if (!(node instanceof HTMLElement)) return ''

  const classes = node.classList
  for (const dropped of DROP_CLASSES) {
    if (classes.contains(dropped)) return ''
  }
  // 属性区是文件的元数据，不属于正文
  if (classes.contains('cm-md-frontmatter')) return ''
  if (classes.contains('cm-md-html-block') || classes.contains('cm-md-html-inline')) {
    return childrenHTML(node)
  }
  if (classes.contains('cm-md-link')) {
    const href = node.getAttribute('data-href') ?? ''
    return `<a href="${escapeAttribute(href)}">${childrenHTML(node)}</a>`
  }
  if (classes.contains('cm-md-footnote-ref')) {
    return `<sup>${escapeText(node.textContent ?? '')}</sup>`
  }
  // 公式（KaTeX）、mermaid 图、图片：它们已经是能独立成立的 HTML，原样带走
  if (classes.contains('cm-md-math') || classes.contains('cm-md-mermaid')) {
    return node.innerHTML
  }
  if (node.tagName === 'IMG') return node.outerHTML
  if (classes.contains('cm-md-image')) {
    // 编辑器给图片套了一层定位用的 span，交出去的文档里只要那张图
    const img = node.querySelector('img')
    return img ? img.outerHTML : ''
  }

  for (const [className, tag] of Object.entries(INLINE_TAGS)) {
    if (classes.contains(className)) return `<${tag}>${childrenHTML(node)}</${tag}>`
  }
  // 其它（编辑器自己的行内 span 等）只保留里面的文字
  return childrenHTML(node)
}

function childrenHTML(node: Node): string {
  return Array.from(node.childNodes).map(inlineHTML).join('')
}

/** 一行里的正文（去掉列表标记、复制按钮这些零件）。 */
function lineHTML(line: HTMLElement): string {
  return childrenHTML(line)
}

/**
 * 列表 → `<ul>` / `<ol>`。
 *
 * 嵌套的列表必须是父 `<li>` 的孩子（`<li>父<ul><li>子</li></ul></li>`）。写成
 * `<li>父</li><ul>…</ul>` 就是非法结构：浏览器自己猜，Typora 与 Word 猜得各不相同。
 * 2026-09-26 报的「粘到 Typora 里整篇变成项目符号」就是它。
 * 所以用一个栈：`<li>` 先不闭合，下一层列表直接开在它里面。
 */
function renderList(lines: HTMLElement[]): string {
  let html = ''
  const open: { depth: number; ordered: boolean }[] = []
  const tagOf = (ordered: boolean): string => (ordered ? 'ol' : 'ul')

  for (const line of lines) {
    const depth = listDepth(line)
    const ordered = isOrdered(line)
    while (open.length > 0 && open[open.length - 1].depth > depth) {
      html += `</li></${tagOf(open.pop()!.ordered)}>`
    }
    if (open.length === 0 || open[open.length - 1].depth < depth) {
      html += `<${tagOf(ordered)}>`
      open.push({ depth, ordered })
    } else if (open[open.length - 1].ordered !== ordered) {
      // 同一层换了列表类型
      html += `</li></${tagOf(open.pop()!.ordered)}><${tagOf(ordered)}>`
      open.push({ depth, ordered })
    } else {
      html += '</li>'
    }
    // 行首的空格是缩进，不是内容
    html += `<li>${lineHTML(line).replace(/^\s+/, '')}`
  }
  while (open.length > 0) html += `</li></${tagOf(open.pop()!.ordered)}>`
  return html
}

function renderCode(lines: HTMLElement[]): string {
  // 第一行是围栏（语言标记留在行里），最后一行是收尾围栏
  const body = lines.slice(1)
  if (body.length > 0 && (body[body.length - 1].textContent ?? '').trim() === '') body.pop()
  const code = body.map((line) => line.textContent ?? '').join('\n')
  return `<pre><code>${escapeText(code)}</code></pre>`
}

function renderGroup(kind: LineKind, lines: HTMLElement[]): string {
  if (kind === 'code') return renderCode(lines)
  if (kind === 'li') return renderList(lines)
  if (kind === 'quote') {
    return `<blockquote>${lines.map((line) => `<p>${lineHTML(line)}</p>`).join('')}</blockquote>`
  }
  if (kind === 'table') {
    const table = lines[0].querySelector<HTMLElement>('.cm-md-table-widget')
    if (!table) return ''
    // 表格本身是语义标签，只有那个类名是编辑器自己的
    const clone = table.cloneNode(true) as HTMLElement
    clone.classList.remove('cm-md-table-widget')
    return clone.outerHTML
  }
  if (kind === 'hr') return '<hr>'
  if (kind === 'empty') return '<p><br></p>'
  if (kind.startsWith('h')) {
    const level = kind.slice(1)
    return `<h${level}>${lineHTML(lines[0])}</h${level}>`
  }
  return `<p>${lineHTML(lines[0])}</p>`
}

/** 同类且可合并的块：列表、引用、代码要合起来才成形。 */
function mergeable(kind: LineKind): boolean {
  return kind === 'code' || kind === 'li' || kind === 'quote'
}

/** 把一串「行」按块翻译成 HTML。行与行之间是编辑器自己的排版，这里重建文档结构。 */
function blocksHTML(nodes: Node[]): string {
  let html = ''
  let index = 0
  while (index < nodes.length) {
    const node = nodes[index]
    if (!isLineElement(node)) {
      // 选区从一个行的中间开始或结束：连续的行内片段属于同一行，要合成一个段落。
      // 不合并的话，`含 **加粗**、` 会变成「含」「加粗」「、」三个段落。
      const inline: string[] = []
      while (index < nodes.length && !isLineElement(nodes[index])) {
        inline.push(inlineHTML(nodes[index]))
        index += 1
      }
      const merged = inline.join('')
      if (merged.trim() !== '') html += `<p>${merged}</p>`
      continue
    }
    const kind = lineKind(node)
    const group = [node]
    if (mergeable(kind)) {
      let next = index + 1
      while (next < nodes.length) {
        const candidate = nodes[next]
        if (!(candidate instanceof HTMLElement) || lineKind(candidate) !== kind) break
        group.push(candidate)
        next += 1
      }
      index = next
    } else {
      index += 1
    }
    html += renderGroup(kind, group)
  }
  return html
}

/** 这一行是不是编辑器画出来的行（选区完整盖住的行）。 */
function isLineElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && node.classList.contains('cm-line')
}

/** 选中的一段 → 干净的 HTML。复制用它。 */
export function selectionHTMLFrom(fragment: DocumentFragment): string {
  return blocksHTML(Array.from(fragment.childNodes))
}

/** 整篇文档 → 干净的 HTML。导出 HTML 用它。 */
export function documentHTMLFrom(root: HTMLElement): string {
  return blocksHTML(Array.from(root.children))
}
