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
  'cm-md-table-caret-anchor',
  'cm-md-table-marker',
  'cm-md-table-paragraph',
])

type LineKind = 'code' | 'li' | 'quote' | 'hr' | 'table' | 'empty' | 'p' | `h${1 | 2 | 3 | 4 | 5 | 6}`

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

function lineKind(line: HTMLElement, includeList = true): LineKind {
  const classes = line.classList
  // 引用排在最前：引用里的标题、列表、代码由 renderGroup 剥掉引用后再按块翻译
  if (classes.contains('cm-md-blockquote')) return 'quote'
  for (let level = 1; level <= 6; level++) {
    if (classes.contains(`cm-md-atxheading${level}`)) return `h${level}` as LineKind
  }
  // 图表沿用围栏行的代码块类，已有 SVG 时不能再按代码围栏删掉。
  if (line.querySelector('.cm-md-mermaid svg')) return 'p'
  if (classes.contains('cm-md-codeblock')) return 'code'
  if (classes.contains('cm-md-hr')) return 'hr'
  if (line.querySelector('.cm-md-table-widget') || classes.contains('cm-md-table-row') || classes.contains('cm-md-table-delimiter')) return 'table'
  if (classes.contains('cm-md-frontmatter')) return 'empty'
  if (includeList) for (let depth = 0; depth <= 6; depth++) {
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
  if (node.tagName === 'BR') return '<br>'
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
 * 开一个列表标签。
 *
 * 有序列表的起点由第一项写的数字决定（CommonMark 只认它，后面的数字一律重排，
 * 所以 `<li>` 里不带 `value`）。这里读的是渲染后的那一份，第一项的序号一定就是原文。
 */
function listTag(line: HTMLElement, ordered: boolean): string {
  if (!ordered) return '<ul>'
  const start = Number.parseInt(line.querySelector('.cm-md-listmark')?.textContent ?? '', 10)
  return Number.isFinite(start) && start !== 1 ? `<ol start="${start}">` : '<ol>'
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
      html += listTag(line, ordered)
      open.push({ depth, ordered })
    } else if (open[open.length - 1].ordered !== ordered) {
      // 同一层换了列表类型
      html += `</li></${tagOf(open.pop()!.ordered)}>${listTag(line, ordered)}`
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

type ListPath = { list: number; item: number; start?: number }[]

/** 块容器从首个源码行读取列表归属。 */
function listContext(node: Node): { path: ListPath; quoted: boolean } | null {
  if (!(node instanceof HTMLElement)) return null
  const line = node.classList.contains('cm-line') ? node : node.querySelector<HTMLElement>('.cm-line')
  if (!line?.classList.contains('cm-md-li') || !line.dataset.listPath) return null
  return { path: JSON.parse(line.dataset.listPath) as ListPath, quoted: line.dataset.listQuoted === 'true' }
}

/** 同一个源码 ListItem 的多段、表格和子列表，共用一个 li。 */
function renderOwnedList(nodes: Node[], depth: number): string {
  let html = '', index = 0
  while (index < nodes.length) {
    const first = listContext(nodes[index])!.path[depth]
    const tag = first.start === undefined ? 'ul' : 'ol'
    html += first.start !== undefined && first.start !== 1 ? `<ol start="${first.start}">` : `<${tag}>`
    while (index < nodes.length && listContext(nodes[index])!.path[depth].list === first.list) {
      const item = listContext(nodes[index])!.path[depth].item
      const group: Node[] = []
      while (index < nodes.length) {
        const path = listContext(nodes[index])!.path[depth]
        if (path.list !== first.list || path.item !== item) break
        group.push(nodes[index++])
      }
      const body = blocksHTML(group, depth)
      // 单段紧凑列表沿用原来的 li>文字；多块列表保留段落边界。
      const singleParagraph = body.startsWith('<p>') && body.indexOf('</p>') === body.length - 4
      html += `<li>${singleParagraph ? body.slice(3, -4).trimStart() : body}</li>`
    }
    html += `</${tag}>`
  }
  return html
}

function isCodeFenceStart(line: HTMLElement): boolean {
  return line.classList.contains('cm-md-codeblock-first') || /^(`{3,}|~{3,})/.test((line.textContent ?? '').trimStart())
}

function isCodeFenceEnd(line: HTMLElement): boolean {
  return line.classList.contains('cm-md-codeblock-last') || /^(`{3,}|~{3,})\s*$/.test((line.textContent ?? '').trim())
}

function renderCode(lines: HTMLElement[]): string {
  // 第一行是首行围栏，最后一行是收尾围栏；若选区只截取内部几行，则不截断内容
  let body = lines
  if (body.length > 0 && isCodeFenceStart(body[0])) {
    body = body.slice(1)
  }
  if (body.length > 0 && isCodeFenceEnd(body[body.length - 1])) {
    body = body.slice(0, -1)
  }
  const code = body.map((line) => line.textContent ?? '').join('\n')
  return `<pre><code>${escapeText(code)}</code></pre>`
}

function renderGroup(kind: LineKind, lines: HTMLElement[], ownerDepth = -1): string {
  if (kind === 'code') return renderCode(lines)
  if (kind === 'li') return renderList(lines)
  if (kind === 'quote') {
    const inner = lines.map(line => {
      const clone = line.cloneNode(true) as HTMLElement
      clone.classList.remove('cm-md-blockquote')
      return clone
    })
    return `<blockquote>${blocksHTML(inner, ownerDepth)}</blockquote>`
  }
  if (kind === 'table') {
    let html = ''
    let head = ''
    let body: string[] = []
    const flush = () => {
      if (head || body.length) {
        let table = `<table>${head}<tbody>${body.join('')}</tbody></table>`
        const first = lines[0]
        // 带 listPath 的行由列表归属逻辑处理；独立合入 main 时沿用旧列表信息。
        if (first.classList.contains('cm-md-li') && !first.dataset.listPath) {
          const ordered = isOrdered(first)
          table = `${listTag(first, ordered)}<li>${table}</li></${ordered ? 'ol' : 'ul'}>`
        }
        html += table
      }
      head = ''
      body = []
    }
    for (const line of lines) {
      if (line.classList.contains('cm-md-table-delimiter')) continue
      const header = line.classList.contains('cm-md-table-header')
      const cells = tableCellsHTML(Array.from(line.querySelectorAll<HTMLElement>('.cm-md-table-cell')), header ? 'th' : 'td')
      if (header) {
        flush()
        head = `<thead><tr>${cells}</tr></thead>`
      } else body.push(`<tr>${cells}</tr>`)
      if (line.classList.contains('cm-md-table-last')) {
        flush()
      }
    }
    flush()
    return html
  }
  if (kind === 'hr') return '<hr>'
  // 空行在 markdown 里只是段落分隔，元素本身已经把它表达出来了。
  // 再输出一个 `<p><br></p>` 就是**多一段**：粘到 Typora 里段落之间会凭空多一行
  //（2026-10-06 报的），导出的 HTML 在浏览器里同样多一截空白。
  if (kind === 'empty') return ''
  if (kind.startsWith('h')) {
    const level = kind.slice(1)
    return `<h${level}>${lineHTML(lines[0])}</h${level}>`
  }
  const separator = ownerDepth >= 0 && lines.length > 1 ? '<br>' : '\n'
  return `<p>${lines.map(line => {
    const content = lineHTML(line)
    return line.dataset.listPath ? content.replace(/^[ \t]+/, '') : content
  }).join(separator)}</p>`
}

/** 同类且可合并的块：列表、引用、代码要合起来才成形。 */
function mergeable(kind: LineKind): boolean {
  return kind === 'code' || kind === 'li' || kind === 'quote' || kind === 'table'
}

/** 把一串「行」按块翻译成 HTML。行与行之间是编辑器自己的排版，这里重建文档结构。 */
function blocksHTML(nodes: Node[], ownerDepth = -1): string {
  let html = ''
  let index = 0
  let quoteEnd = 0
  while (index < nodes.length) {
    const node = nodes[index]
    const context = listContext(node)
    // 引用在列表外时先包引用；列表里的引用则由该列表项递归处理。
    if (index >= quoteEnd && node instanceof HTMLElement && node.classList.contains('cm-md-blockquote') &&
        (!context || context.quoted || context.path.length <= ownerDepth + 1)) {
      const group = [node]
      let next = index + 1
      while (next < nodes.length) {
        const candidate = nodes[next]
        if (!(candidate instanceof HTMLElement) || !candidate.classList.contains('cm-md-blockquote')) break
        group.push(candidate)
        next += 1
      }
      quoteEnd = next
      // 只重建带列表归属的引用；普通引用保留既有处理，整段只扫描一次。
      if (group.some(line => listContext(line))) {
        const inner = group.map(line => {
          const clone = line.cloneNode(true) as HTMLElement
          clone.classList.remove('cm-md-blockquote')
          return clone
        })
        html += `<blockquote>${blocksHTML(inner, ownerDepth)}</blockquote>`
        index = next
        continue
      }
    }
    if (context && context.path.length > ownerDepth + 1) {
      const group = [node]
      while (++index < nodes.length) {
        if ((listContext(nodes[index])?.path.length ?? 0) <= ownerDepth + 1) break
        group.push(nodes[index])
      }
      // 从子列表跨到父项的下一项，仍须保留共同外层；只选子项则不补未选父层。
      const depth = ownerDepth < 0
        ? group.reduce((min, part) => Math.min(min, listContext(part)!.path.length - 1), context.path.length - 1)
        : ownerDepth + 1
      html += renderOwnedList(group, depth)
      continue
    }
    if (!isLineElement(node)) {
      // 选区从一个行的中间开始或结束：连续的行内片段属于同一行，要合成一个段落。
      // 不合并的话，`含 **加粗**、` 会变成「含」「加粗」「、」三个段落。
      const inline: Node[] = []
      while (index < nodes.length && !isLineElement(nodes[index])) {
        inline.push(nodes[index])
        index += 1
      }
      // 同一行里跨了几个单元格：交出这几格组成的一行表格，否则格子之间的分隔会丢，两格并成一段
      const cells = inline.filter((part): part is HTMLElement => part instanceof HTMLElement && part.classList.contains('cm-md-table-cell'))
      if (cells.length > 1) {
        html += cells.some(cell => cell.getAttribute('role') === 'columnheader')
          ? `<table><thead><tr>${tableCellsHTML(cells, 'th')}</tr></thead></table>`
          : `<table><tbody><tr>${tableCellsHTML(cells, 'td')}</tr></tbody></table>`
        continue
      }
      const merged = inline.map(node => inlineHTML(node)).join('')
      if (merged.trim() !== '') html += `<p>${merged}</p>`
      continue
    }
    const kind = lineKind(node, !context)
    const group = [node]
    const paragraph = node.dataset.listParagraph
    if (mergeable(kind) || (kind === 'p' && paragraph)) {
      let next = index + 1
      while (next < nodes.length) {
        const candidate = nodes[next]
        if (!(candidate instanceof HTMLElement) || lineKind(candidate, !listContext(candidate)) !== kind ||
            (kind === 'p' && candidate.dataset.listParagraph !== paragraph)) break
        group.push(candidate)
        next += 1
      }
      index = next
    } else {
      index += 1
    }
    html += renderGroup(kind, group, ownerDepth)
  }
  return html
}

/** 这一行是不是编辑器画出来的行（选区完整盖住的行）。 */
function isLineElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && node.classList.contains('cm-line')
}

function tableCellsHTML(cells: HTMLElement[], tag: 'th' | 'td'): string {
  return cells.map(cell => `<${tag} style="overflow-wrap:anywhere;word-break:normal;text-align:${cell.style.textAlign || 'left'}">${childrenHTML(cell).replace(/^[ \t]+|[ \t]+$/g, '')}</${tag}>`).join('')
}

/** 列表/引用归属与分组都读取源码行；先展开表格的布局包装，保留每行的归属信息。 */
function tableLines(nodes: Node[]): Node[] {
  return nodes.flatMap(node => node instanceof HTMLElement && node.classList.contains('cm-md-table-widget')
    ? Array.from(node.childNodes) : [node])
}

/** 选中的一段 → 干净的 HTML。复制用它。 */
export function selectionHTMLFrom(fragment: DocumentFragment): string {
  return blocksHTML(tableLines(Array.from(fragment.childNodes)))
}

/** 整篇文档 → 干净的 HTML。导出 HTML 用它。 */
export function documentHTMLFrom(root: HTMLElement): string {
  return blocksHTML(tableLines(Array.from(root.children)))
}
