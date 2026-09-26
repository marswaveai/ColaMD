// 脚注：`[^note]` 引用与 `[^note]: 内容` 定义。
//
// 语法解析器不认脚注——`[^note]` 会被它当成一个「没有地址的引用式链接」，定义行更是
// 一行普通文字。所以这两件事在这里用文本扫描解决：文件里的字节就是真相，扫描一遍
// 就能得到全部信息，不需要第二份状态。

/** 引用：`[^note]`。 */
export const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g

/** 定义行：`[^note]: 内容`（最多三个空格缩进）。 */
const FOOTNOTE_DEF_LINE_RE = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/

/**
 * 扫出所有脚注定义。
 *
 * 定义可以续行：后续缩进（或空行之后的缩进）属于同一条定义，直到出现新的定义、
 * 或者遇到一段不再缩进的内容。返回的 Map 保持文件里的先后顺序。
 */
export function footnoteDefinitions(text: string): Map<string, string> {
  const definitions = new Map<string, string>()
  const lines = text.split('\n')
  let current: string | null = null

  for (const raw of lines) {
    const match = FOOTNOTE_DEF_LINE_RE.exec(raw)
    if (match) {
      current = match[1]
      definitions.set(current, match[2].trim())
      continue
    }
    if (current === null) continue
    // 缩进或空行算续行，否则这条定义结束
    if (/^[ \t]+\S/.test(raw)) {
      const continuation = raw.trim()
      definitions.set(current, `${definitions.get(current) ?? ''} ${continuation}`.trim())
      continue
    }
    if (raw.trim() === '') continue
    current = null
  }

  return definitions
}

/**
 * 引用编号：按**首次出现**的顺序编号，和 Obsidian 一样。
 *
 * 编号只影响显示，不写回文件——文件里永远是用户写的那个标签。
 */
export function footnoteNumbers(text: string): Map<string, number> {
  const numbers = new Map<string, number>()
  FOOTNOTE_REF_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FOOTNOTE_REF_RE.exec(text)) !== null) {
    if (!numbers.has(match[1])) numbers.set(match[1], numbers.size + 1)
  }
  return numbers
}
