// 点击时才读取当前公式的 DOM 和源码；不参与装饰重建、输入或滚动。

/** KaTeX 的 HTML 文本与原始输入不同的常用单字符。命令展开不在此映射。 */
const sourceSymbols: Readonly<Record<string, string>> = { '−': '-', '∗': '*', '′': "'" }

type ArgumentKind = 'hidden' | 'size' | 'optional' | 'visible'
// 只描述不画出来的参数，正文参数仍由普通扫描处理。依据 KaTeX 公开命令语法，
// 不读取解析树、渲染私有字段，也不改变 trust 或渲染输出。
const parameters: Readonly<Record<string, readonly ArgumentKind[]>> = {
  begin: ['hidden'], end: ['hidden'],
  color: ['hidden'], textcolor: ['hidden'], colorbox: ['hidden'], fcolorbox: ['hidden', 'hidden'],
  kern: ['size'], mkern: ['size'], hskip: ['size'], mskip: ['size'], hspace: ['size'],
  raisebox: ['size'], rule: ['optional', 'size', 'size'], above: ['size'],
  genfrac: ['visible', 'visible', 'size', 'hidden'],
  smash: ['optional'],
  phantom: ['hidden'], hphantom: ['hidden'], vphantom: ['hidden'],
  // trust:false 下这些命令不会生成受信任 HTML，参数仍不能充当正文候选。
  href: ['hidden', 'hidden'], url: ['hidden'],
  htmlClass: ['hidden', 'hidden'], htmlId: ['hidden', 'hidden'], htmlStyle: ['hidden', 'hidden'], htmlData: ['hidden', 'hidden'],
  includegraphics: ['optional', 'hidden'],
}

function skipSpace(source: string, start: number): number {
  while (start < source.length) {
    if (/\s/.test(source[start])) start++
    else if (source[start] === '%') {
      const end = source.indexOf('\n', start)
      start = end < 0 ? source.length : end + 1
    } else break
  }
  return start
}

/** 一个 TeX 参数的源码终点；保留分组层次，转义括号不参与配对。 */
function argumentEnd(source: string, start: number, kind: ArgumentKind): number {
  const open = kind === 'optional' ? '[' : '{'
  if (source[start] === open) {
    const close = open === '[' ? ']' : '}'
    let depth = 1, braces = 0
    for (let i = start + 1; i < source.length; i++) {
      if (source[i] === '\\') { i++; continue }
      if (source[i] === '%') { i = source.indexOf('\n', i); if (i < 0) return source.length; continue }
      if (open === '[') {
        if (source[i] === '{') braces++
        if (source[i] === '}') braces--
        if (braces) continue
      }
      if (source[i] === open) depth++
      if (source[i] === close && --depth === 0) return i + 1
    }
    return source.length
  }
  if (kind === 'optional') return start
  if (kind === 'size') {
    const size = /^[+-]?\s*(?:\d+(?:\.\d*)?|\.\d+)\s*[a-z]{2}\s*/.exec(source.slice(start))
    if (size) return start + size[0].length
  }
  const token = /^\\(?:[a-zA-Z@]+|.)|^[\s\S]/u.exec(source.slice(start))
  return start + (token?.[0].length ?? 0)
}

function closestSource(source: string, glyph: string, reference: number): number | undefined {
  const skipped = new Map<number, number>()
  let nearest: number | undefined
  for (let i = 0; i < source.length;) {
    const end = skipped.get(i)
    if (end !== undefined) { i = end; continue }
    if (source[i] === '%') { i = skipSpace(source, i); continue }
    let character = String.fromCodePoint(source.codePointAt(i)!)
    let position = i
    if (character === '\\') {
      const token = /^\\([a-zA-Z@]+|.)/u.exec(source.slice(i))
      if (!token) break
      const command = token[1]
      i += token[0].length
      // 自定义展开和按样式择支没有可靠的字面对应，整式使用比例回退。
      if (/^(?:def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|mathchoice|char|@char|verb|verb\*|string)$/.test(command)) return undefined
      let next = i
      const star = skipSpace(source, next)
      if (/^(?:hspace|operatorname|tag)$/.test(command) && source[star] === '*') { skipped.set(star, star + 1); next = star + 1 }
      // KaTeX 的行间距选项必须紧跟 \\\\；中间有空白时 [1em] 会作为正文显示。
      if (command === '\\' && source[i] === '[') skipped.set(i, argumentEnd(source, i, 'optional'))
      if (/^(?:left|right|middle|[bB]igg?[lrm]?)$/.test(command)) {
        const start = skipSpace(source, next)
        if (source[start] === '.') skipped.set(start, start + 1)
      }
      for (const kind of parameters[command] ?? []) {
        const start = skipSpace(source, next)
        next = argumentEnd(source, start, kind)
        if (kind !== 'visible' && next > start) skipped.set(start, next)
      }
      if (command === 'begin') {
        const start = skipSpace(source, i)
        const environment = source.slice(start + 1, next - 1).trim()
        const kind = /^(?:array|darray|subarray|alignat\*?|alignedat)$/.test(environment) ? 'hidden'
          : /^(?:[pbBvV]?matrix)\*$/.test(environment) ? 'optional' : undefined
        if (kind) {
          const start = skipSpace(source, next)
          const end = argumentEnd(source, start, kind)
          if (end > start) skipped.set(start, end)
        }
      }
      // 只有转义的字面符号可直接对应字符；\alpha 等命令名不能成为候选。
      if (command.length !== 1 || !'{}%$&#_'.includes(command)) continue
      character = command
      position++
    } else {
      i += character.length
      if (/[\s{}^_&$]/.test(character)) continue
    }
    if ((character === glyph || character === sourceSymbols[glyph]) &&
        (nearest === undefined || Math.abs(position - reference) < Math.abs(nearest - reference))) nearest = position
  }
  return nearest
}

/** caret API 给的是最近边界，必须用相邻字符的真实 Range 确认点确实在字形盒内。 */
function clickedGlyph(widget: HTMLElement, target: Element, x: number, y: number): { text: string; after: boolean } | undefined {
  const doc = widget.ownerDocument
  // 线条、SVG 与间距不是文本；caret API 会把它们吸附到旁边的字，不能据此命中。
  if (target.closest('svg, .frac-line, .mspace, .rule')) return undefined
  const elements = doc.elementsFromPoint(x, y)
  // KaTeX 的字形行盒也可能盖在 1px 分数线上，线条本身仍在命中栈里。
  if (elements.some(element => widget.contains(element) &&
      element.matches('.frac-line, .overline-line, .underline-line, .hline, .hdashline'))) return undefined
  // caretPositionFromPoint 尚未进入当前 TypeScript DOM 类型。
  const caretDoc = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  const caret = caretDoc.caretPositionFromPoint?.(x, y)
  const range = !caretDoc.caretPositionFromPoint ? doc.caretRangeFromPoint?.(x, y) : null
  const node = caret?.offsetNode ?? range?.startContainer
  const offset = caret?.offset ?? range?.startOffset
  const atNode = (node: Node, offsets?: number[]) => {
    if (node.nodeType !== Node.TEXT_NODE || !widget.contains(node) ||
      !node.parentElement?.closest('.katex-html') || node.parentElement.closest('.katex-mathml') ||
        getComputedStyle(node.parentElement).visibility !== 'visible' ||
        getComputedStyle(node.parentElement).color === 'rgba(0, 0, 0, 0)') return undefined
    const text = node.textContent ?? ''
    let at = 0
    for (const character of text) {
      const start = at
      at += character.length
      if ((offsets && !offsets.includes(start)) || /\s/.test(character)) continue
      const box = doc.createRange()
      box.setStart(node, start)
      box.setEnd(node, at)
      const rect = box.getBoundingClientRect()
      if (rect.width > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return { text: character, after: x >= (rect.left + rect.right) / 2 }
      }
    }
    return undefined
  }
  if (node && offset !== undefined) {
    const text = node.textContent ?? ''
    const start = offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? '') ? offset - 1 : offset
    const previous = start > 1 && /[\uDC00-\uDFFF]/.test(text[start - 1]) ? start - 2 : start - 1
    const hit = atNode(node, [start, previous])
    if (hit) return hit
  }
  // Chromium 会把 contenteditable=false 的右半边吸到 widget 外，也会命中 KaTeX
  // 分母/下标上方的空 vlist 盒。只细化点下元素的直接文本，用公开 Range 验证；
  // 不数 DOM 次序，不遍历整棵公式，也不临时改 contenteditable 或 pointer-events。
  for (const element of elements) {
    if (!widget.contains(element) || !element.closest('.katex-html')) continue
    for (const child of element.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE) continue
      const hit = atNode(child)
      if (hit) return hit
    }
  }
  return undefined
}

/** 返回相对内容区的 UTF-16 落点；不能证明字面对应时由调用方保留原比例估算。 */
export function inlineMathClickOffset(widget: HTMLElement, target: Element, source: string, x: number, y: number, reference: number): number | undefined {
  const glyph = clickedGlyph(widget, target, x, y)
  if (!glyph) return undefined
  const position = closestSource(source, glyph.text, reference)
  return position === undefined ? undefined : position + (glyph.after ? String.fromCodePoint(source.codePointAt(position)!).length : 0)
}
