// 公式定界符的扫描：决定「哪一段算公式，哪一段是普通文字」。
//
// 这里只做判定，不画任何东西，也不改任何字节。规则照 Obsidian，保守优先：
// 只有当一对 `$` 能无歧义配对时才认成公式，否则一律当普通字符。
// 保守的代价只是「这段没渲染成公式」，而文本永远安全，所以宁可严。
//
// 为什么不用 `looksLikeLatex()` 那种启发式（旧 math-guard.ts 的做法）：
// 那种做法是先解析成公式、再判定它不像公式、再退回文本。退回的对象是解析后的语法
// 节点，原文里的 `**` 在这条路上已经不存在了，于是用户的加粗标记会丢。而且在树优先
// 架构里，退回还得重新序列化整篇文档，又引出转义和偏移量取字符两个新问题。
// 判定前移到扫描阶段就没有「退回」这回事了。

export interface Excluded {
  from: number
  to: number
}

export interface MathRange {
  from: number
  to: number
  /** 定界符之间的源码。 */
  code: string
  /** 是否独占整行（决定用块级还是行内方式渲染）。 */
  block: boolean
}

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch)
// 结尾 `$` 后面跟着数字，说明这更可能是「美元 5 元」而不是公式定界符。
// 这一条是拦住 `$349`、`$1,299.99`、`$5 和 $6` 的关键。
const isDigit = (ch: string | undefined): boolean => ch !== undefined && /[0-9０-９]/.test(ch)

/**
 * 把排除区间的字符换成空格，长度与换行结构保持不变。
 * 这样后续扫描的偏移量可以直接当作原文下标使用，不必处处做映射。
 * 代码块、行内代码、属性区里的 `$` 就是这样被自动排除的。
 */
function mask(text: string, excluded: Excluded[]): string {
  if (excluded.length === 0) return text
  const chars = text.split('')
  for (const { from, to } of excluded) {
    const start = Math.max(0, from)
    const end = Math.min(chars.length, to)
    for (let i = start; i < end; i++) {
      if (chars[i] !== '\n') chars[i] = ' '
    }
  }
  return chars.join('')
}

/** 从 from 起找下一个未被反斜杠转义的出现位置，找不到返回 -1。 */
function findUnescaped(src: string, needle: string, from: number): number {
  let i = from
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2
      continue
    }
    if (src.startsWith(needle, i)) return i
    i++
  }
  return -1
}

const lineEndAt = (src: string, pos: number): number => {
  const nl = src.indexOf('\n', pos)
  return nl === -1 ? src.length : nl
}

/**
 * 扫描一整篇文本，返回所有公式区间。
 * excluded 里的区间会被当成空白，用于排除代码块与属性区。
 */
export function scanMath(text: string, excluded: Excluded[] = []): MathRange[] {
  const src = mask(text, excluded)
  const out: MathRange[] = []
  const len = src.length
  let i = 0

  while (i < len) {
    const ch = src[i]

    // 反斜杠转义：`\$` 永远只是字面的美元符号，跳过它和它后面的那个字符
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch !== '$') {
      i++
      continue
    }

    // 块公式 `$$...$$`：跨行合法
    if (src[i + 1] === '$') {
      const close = findUnescaped(src, '$$', i + 2)
      if (close !== -1 && close > i + 2) {
        out.push({
          from: i,
          to: close + 2,
          code: src.slice(i + 2, close),
          block: isLineStart(src, i) && isLineEnd(src, close + 1),
        })
        i = close + 2
        continue
      }
      i += 2
      continue
    }

    // 行内公式 `$...$`。开头的 `$` 后面必须紧跟非空白字符
    if (isSpace(src[i + 1])) {
      i++
      continue
    }

    const lineEnd = lineEndAt(src, i)
    let close = -1
    let j = i + 1
    while (j < lineEnd) {
      if (src[j] === '\\') {
        j += 2
        continue
      }
      if (src[j] === '$') {
        // 结尾的 `$` 前面必须紧邻非空白，后面不能是数字
        const okPrev = !isSpace(src[j - 1])
        const okNext = !isDigit(src[j + 1])
        // 区间里若还夹着未转义的 `$`，说明配对不可靠，放弃这一次开头
        const ambiguous = src.slice(i + 1, j).includes('$')
        if (okPrev && okNext && !ambiguous) {
          close = j
          break
        }
      }
      j++
    }

    if (close === -1) {
      i++
      continue
    }
    out.push({
      from: i,
      to: close + 1,
      code: src.slice(i + 1, close),
      block: isLineStart(src, i) && isLineEnd(src, close),
    })
    i = close + 1
  }

  return out
}

/** pos 之前到行首之间是否只有空白（含 pos 位于行首的情形）。 */
function isLineStart(src: string, pos: number): boolean {
  let i = pos - 1
  while (i >= 0 && src[i] !== '\n') {
    if (!/[ \t]/.test(src[i])) return false
    i--
  }
  return true
}

/** pos 之后到行尾之间是否只有空白（含 pos 位于行尾的情形）。 */
function isLineEnd(src: string, pos: number): boolean {
  let i = pos + 1
  while (i < src.length && src[i] !== '\n') {
    if (!/[ \t]/.test(src[i])) return false
    i++
  }
  return true
}

/** 代码区间：围栏代码块、缩进代码块、行内代码。
 * 名字以实际语法树为准（node_modules/.cache/domcheck 验过）：CM6 的 markdown
 * 解析器不产出 HTMLBlock / HTMLTag 节点，所以不列它们。
 */
const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'IndentedCode', 'InlineCode'])

/**
 * 从语法树上收出「不是正文」的区间，供 scanMath 排除。
 * tree 传 null 时只排除属性区（没有语法树可用时的降级）。
 */
export function excludedRanges(
  text: string,
  tree: { iterate(spec: { enter: (node: { name: string; from: number; to: number }) => void }): void } | null,
): Excluded[] {
  const out: Excluded[] = []
  const fm = frontmatterRange(text)
  if (fm) out.push(fm)
  tree?.iterate({
    enter: (node) => {
      if (CODE_NODES.has(node.name)) out.push({ from: node.from, to: node.to })
    },
  })
  return out
}

/**
 * 文件开头的属性区（frontmatter）区间。
 * 它不是正文，里面的 `$`、`*`、`=` 都只是 YAML 的普通字符，不该被渲染。
 */
export function frontmatterRange(text: string): Excluded | null {
  if (!text.startsWith('---')) return null
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd === -1) return null
  if (text.slice(0, firstLineEnd).trim() !== '---') return null

  const rest = text.slice(firstLineEnd + 1)
  const closeRe = /^(?:---|\.\.\.)[ \t]*$/m
  const match = closeRe.exec(rest)
  if (!match) return null
  // 属性区若没有一行像 `key:` 的映射项，说明开头那行 `---` 更可能是分隔线
  const body = rest.slice(0, match.index)
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*[ \t]*:/m.test(body)) return null

  return { from: 0, to: firstLineEnd + 1 + match.index + match[0].length }
}
