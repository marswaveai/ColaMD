#!/usr/bin/env node
// Markdown 往返的验收判官：断言 `save(open(x)) === x`，逐字节比较，不加任何宽容。
//
// 要判什么：用户打开一个 markdown 文件、不做任何修改、保存，文件必须一个字节都不变。
//
// 为什么值得为这件事写一个脚本：编辑器内部一旦「把文件解析成节点树、丢掉原文、保存时
// 再从树重新序列化」，那么用户只改了一个字，整篇文档的标点也可能被顺手改掉。表格分隔行
// 从 `---` 缩成 `-`、`*` 被转义成 `\*`、`snake_case` 变成 `snake\_case`、空文件里凭空
// 多出 `<br />`。这类改动不报错、不崩溃，只是让用户的文件在每次保存后慢慢变形，靠肉眼
// review 抓不住。所以这里把它定义成一个可判定的命题：输出字节必须与输入完全一致。
//
// 2026-09-26 编辑器重写为文本优先：缓冲区里存的就是文件的字节，渲染只是叠在字节上面的
// 一层装饰，保存时把缓冲区原样写回，中间没有任何序列化环节。因此这条路径现在是**恒等**
// 的，一条豁免都不需要。这个脚本就是那份恒等的证明，也是防它退化的网。
//
// 全程纯 Node，不启动 Electron、不开窗口。
//
// 怎么解读结果：
//   [SAME]                 输入输出逐字节一致，这条是保真的。
//   [DIFF known:<名字>]    有差异，但属于 KNOWN_NORMALIZATIONS 里登记过、已查清理由的
//                          条目，不计为失败。清单越长越可疑，理想状态是零条。
//   [DIFF]                 不在清单里，判为违反保真的 bug，会打出输入输出的 JSON 字面量。
// 退出码：默认只要有非清单差异就以 1 退出，可以直接进 CI。
//         加 --report 则只报告不判失败（永远退出 0），用来看全景。
//         退出码 2 表示脚本自身没跑起来（打包失败、harness 崩溃），不是保真问题。
//
// 用法: node scripts/verify-markdown.mjs [--report]     （等价于 npm run verify:markdown）
//
// 实现说明：harness 直接消费应用的 TS 源码（src/renderer/editor/core.ts），用 esbuild 把
// 它连同 DOM stub 打成一个 CJS 再交给 node 跑，产物落在 node_modules/.cache/。DOM stub
// 内联在脚本里，验证脚本因此能长期独立跑，不依赖任何临时文件。
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const REPORT_ONLY = process.argv.includes('--report')

const CACHE = join(ROOT, 'node_modules', '.cache')
const STUB_FILE = join(CACHE, 'verify-markdown-stub.ts')
const ENTRY_FILE = join(CACHE, 'verify-markdown-entry.ts')
const BUNDLE_FILE = join(CACHE, 'verify-markdown-bundle.cjs')
const CASES_FILE = join(CACHE, 'verify-markdown-cases.json')
const RESULT_FILE = join(CACHE, 'verify-markdown-result.json')

// ─── 用例矩阵 ────────────────────────────────────────────────────────────────
// 每条用例是一整份文件的字节。判的是「打开再保存」之后是否逐字节相同。
const CASES = [
  // 行内格式：加粗 / 斜体 / 加粗斜体 / 行内代码 / 删除线 / 高亮
  ['plain paragraph', 'hello world\n'],
  ['bold', 'a **b** c\n'],
  ['italic', 'a *b* c\n'],
  ['bold+italic', 'a ***b*** c\n'],
  ['inline code', 'a `code` b\n'],
  ['strikethrough', '~~gone~~\n'],
  ['strikethrough with bold', '~~删除~~ 保留 **粗体**\n'],
  ['highlight', '==高亮== 普通 **粗体** *斜体*\n'],
  ['highlight standalone', '==高亮==\n'],
  ['underscore emphasis', '_italic_ and __bold__\n'],
  ['code content with underscore', '`a_b_c`\n'],

  // 保真重点：曾被过度转义的字面量。这些正是这次重写要消灭的
  ['literal asterisk math-ish', '3 * 4\n'],
  ['literal dollar', 'costs $5 today\n'],
  ['price pair', '价格 $5，成本 $6 的关系。\n'],
  ['price pair with bold', '价格 $5 的 **加粗** 与 $6 的关系。\n'],
  ['price pair with italic', '价格 $5 的 *斜体* 与 $6 的关系。\n'],
  ['price pair with code', '价格 $5 的 `代码` 与 $6 的关系。\n'],
  ['price only bold', '**加粗** 价格 $5。\n'],
  ['dollar then bold after', 'costs $5 and **bold** here\n'],
  ['single dollar run', '$5 and $6 and $7\n'],
  ['dollar escape', '\\$5 是转义\n'],
  ['math and price on one line', '$x$ 和 $5\n'],
  ['underscore in word', 'snake_case_name\n'],
  ['price with cents', '$1,299.99 起\n'],
  ['price run', '$349 起、$149 和 $599\n'],

  // 真公式必须原样留下
  ['real inline math', '公式 $E=mc^2$ 保留。\n'],
  ['real inline math simple', '$x$\n'],
  ['two formulas same line', '$a$ 和 $b$\n'],
  ['two dollars around bold', 'a $x$ **b** $y$ c\n'],
  ['real math with bold', '公式 $E=mc^2$ 和 **加粗**。\n'],
  ['math block', '$$\nE = mc^2\n$$\n'],
  ['formula in list item', '- $x$\n'],
  ['formula in code fence', '```\n$x$ 不是公式\n```\n'],
  ['formula in inline code', '`$x$` 不是公式\n'],

  // 块级：标题 / 引用 / 列表 / 分隔线
  ['heading', '## Title\n'],
  ['heading level 1', '# Title\n'],
  ['heading level 3', '### Deep\n'],
  ['blockquote', '> quoted text\n'],
  ['blockquote with format', '> **bold** in quote\n'],
  ['bullet list', '- a\n- b\n'],
  ['bullet star marker', '* a\n* b\n'],
  ['bullet plus marker', '+ a\n+ b\n'],
  ['ordered list', '1. a\n2. b\n'],
  ['nested list', '- a\n  - b\n'],
  ['ordered nested list', '1. a\n   1. b\n'],
  ['mixed nested list', '- a\n  1. b\n'],
  ['task list', '- [ ] todo\n- [x] done\n'],
  ['task list nested', '- [ ] a\n  - [x] b\n'],
  ['hr', '---\n'],
  ['asterisk rule', '***\n'],
  ['compact list with blank line inside', '- a\n\n- b\n'],

  // 链接 / 图片 / 脚注
  ['link', '[text](https://example.com)\n'],
  ['link with title', '[text](https://example.com "title")\n'],
  ['autolink', '<https://example.com>\n'],
  ['image', '![alt](pic.png)\n'],
  ['image with title', '![alt](pic.png "caption")\n'],
  ['footnote', 'text[^1]\n\n[^1]: note\n'],

  // 代码块
  ['fence', '```js\nconst a = 1\n```\n'],
  ['fence python', '```python\nprint(1)\n```\n'],
  ['fence tilde', '~~~\nplain\n~~~\n'],

  // 表格
  ['table', '| a | b |\n| --- | --- |\n| 1 | 2 |\n'],
  ['table alignment', '| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n'],
  ['table with inline format', '| a | b |\n| --- | --- |\n| **x** | `y` |\n'],
  ['table with math', '| 公式 | 价格 |\n| --- | --- |\n| $x$ | $5 |\n'],

  // 换行风格与边界
  ['line breaks', 'line one\nline two\n'],
  ['crlf body', 'line one\r\nline two\r\n'],
  ['crlf with formatting', '# Title\r\n\r\n有 **加粗** 和 $5 的一段。\r\n'],
  ['escaped asterisk', 'literal \\* star\n'],
  ['trailing blank line', 'text\n\n'],
  ['trailing blank lines x3', 'text\n\n\n\n'],
  ['empty file', ''],
  ['only newline', '\n'],

  // CJK 与容易被误读的普通文本
  ['cjk punctuation', '中文，标点。还有「引号」\n'],
  ['cjk fullwidth punctuation', '这是一个句子，包含「引号」和（括号）。\n'],
  ['hash', 'C# 语言\n'],
  ['percent', '100% 完成\n'],
  ['curly braces', '{a}\n'],
  ['bracket draft', '[草稿]\n'],
  ['pipe in prose', 'a | b\n'],
  ['underscores and dashes', 'a_b-c-d_e\n'],
  ['regex-ish', '匹配 /^https?:\\/\\/\\S+$/ 的写法\n'],
  ['file path', '路径 /Users/foo/bar_baz.md 存在\n'],

  // 整篇文档：把上面各类混在一起，接近真实文件
  ['long mixed document', [
    '# 标题',
    '',
    '一段文字，包含 **加粗**、*斜体*、`代码`、==高亮== 和 ~~删除~~。',
    '',
    '- 列表一',
    '- 列表二',
    '',
    '> 引用',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '| 列 | 值 |',
    '| --- | --- |',
    '| a | 1 |',
    '',
    '公式 $E = mc^2$ 结束。',
    '',
    '价格 $349 起，另有 $1,299.99 一款。',
    '',
  ].join('\n')],

  // 属性区：文本优先之后它只是文件开头的一段文本，必须原样写回
  ['frontmatter file', '---\ntitle: Hello\ntags:\n  - a\npublish: true\n---\n\n# Body\n\nText\n'],
  ['frontmatter only', '---\ntitle: Only\n---\n'],
  ['frontmatter with dollar and star', '---\ntitle: $5 起\nprice: \'*3\'\n---\n\n正文\n'],
]

// ─── 已知可接受的归一化 ──────────────────────────────────────────────────────
// 只登记「差异已经查清、且对用户文件无害」的条目，每条都要能说清理由。
// 归一化做成一条链：按顺序作用在**输入和输出**两侧，再比较结果，这样一篇同时命中的
// 用例也能正确归类，而不是只认第一条。
//
// 注意：`3 * 4` 被转义成 `3 \* 4`、`a_b_c` 被转义、`$5` 被转义成 `\$5`、空文件里
// 多出 `<br />` 这些是**待修的 bug**，不属于这一类，绝不登记。文本优先之后它们应该
// 全部消失；若还出现，说明新核心没有真正接上保存路径，必须当 bug 处理。
const KNOWN_NORMALIZATIONS = []

// ─── harness 源码（临时产物，落在 node_modules/.cache/）────────────────────
// CodeMirror 的 EditorView 需要一个最小的 DOM 环境。这是「够用就好」的一份，
// 只覆盖 EditorView 创建与测量会碰到的东西。
const DOM_STUB = `
function el() {
  const node = {
    style: {},
    dataset: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)) },
      remove(...c) { c.forEach((x) => this._s.delete(x)) },
      contains: (c) => false,
      toggle() {},
    },
    children: [],
    childNodes: [],
    parentNode: null,
    get ownerDocument() { return globalThis.document },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); if (c) c.parentNode = this; return c },
    append(...cs) { cs.forEach((c) => this.appendChild(c)) },
    removeChild() {},
    insertBefore(c) { this.children.unshift(c); this.childNodes.unshift(c); if (c) c.parentNode = this; return c },
    replaceChild() {},
    remove() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
    getClientRects: () => [],
    insertAdjacentHTML() {},
    focus() {},
    blur() {},
    cloneNode() { return el() },
    setRangeText() {},
    scrollIntoView() {},
    matches: () => false,
    get firstChild() { return this.childNodes[0] ?? null },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null },
    get isConnected() { return true },
  }
  return node
}
const documentStub = {
  ...el(),
  documentElement: el(),
  head: el(),
  body: el(),
  createElement: () => el(),
  createElementNS: () => el(),
  createTextNode: (t) => { const n = el(); n.textContent = t; return n },
  createDocumentFragment: () => el(),
  createRange: () => ({
    setStart() {}, setEnd() {}, collapse() {}, selectNodeContents() {},
    cloneRange() { return {} }, detach() {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    getClientRects: () => [],
  }),
  getElementById: () => el(),
  querySelector: () => null,
  querySelectorAll: () => [],
  contains: () => false,
  addEventListener() {},
  removeEventListener() {},
  execCommand() {},
  getSelection: () => ({ rangeCount: 0, getRangeAt: () => null, removeAllRanges() {}, addRange() {}, anchorNode: null, focusNode: null }),
}
const windowStub = {
  document: documentStub,
  navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node', platform: 'MacIntel' },
  location: { href: 'http://localhost/', search: '', hash: '' },
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  requestAnimationFrame: (cb) => setTimeout(() => cb(0), 0),
  cancelAnimationFrame: () => {},
  getComputedStyle: () => ({ getPropertyValue: () => '', backgroundColor: '' }),
  setTimeout,
  clearTimeout,
  innerWidth: 1440,
  innerHeight: 900,
  devicePixelRatio: 1,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  electronAPI: {},
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
  DOMParser: class { parseFromString() { return { body: el(), documentElement: el(), querySelector: () => null, querySelectorAll: () => [] } } },
  XMLSerializer: class { serializeToString() { return '' } },
  getSelection: () => ({ rangeCount: 0, getRangeAt: () => null, removeAllRanges() {}, addRange() {} }),
  HTMLTextAreaElement: class {},
  HTMLElement: class {},
}
globalThis.window = windowStub
windowStub.window = windowStub
documentStub.defaultView = windowStub
globalThis.document = documentStub
documentStub.ownerDocument = documentStub
for (const key of ['documentElement', 'head', 'body']) documentStub[key].ownerDocument = documentStub
try { globalThis.navigator = windowStub.navigator } catch { /* 只读，跳过 */ }
globalThis.location = windowStub.location
globalThis.getComputedStyle = windowStub.getComputedStyle
globalThis.requestAnimationFrame = windowStub.requestAnimationFrame
globalThis.cancelAnimationFrame = windowStub.cancelAnimationFrame
globalThis.localStorage = windowStub.localStorage
globalThis.ResizeObserver = windowStub.ResizeObserver
globalThis.MutationObserver = windowStub.MutationObserver
globalThis.DOMParser = windowStub.DOMParser
globalThis.XMLSerializer = windowStub.XMLSerializer
globalThis.getSelection = windowStub.getSelection
globalThis.Node = class {}
globalThis.Element = class {}
globalThis.HTMLElement = class {}
globalThis.Window = class {}
globalThis.HTMLPreElement = class {}
globalThis.HTMLTextAreaElement = class {}
globalThis.ClipboardEvent = class {}
globalThis.InputEvent = class {}
globalThis.Event = class { constructor(t) { this.type = t } preventDefault() {} stopPropagation() {} }
globalThis.CustomEvent = globalThis.Event
globalThis.KeyboardEvent = class { constructor(t) { this.type = t } preventDefault() {} stopPropagation() {} }
globalThis.MouseEvent = class { constructor(t) { this.type = t } preventDefault() {} stopPropagation() {} }
`

// 一句绝对路径的引号字面量，供 harness 源码引用应用源码（harness 生成在 cache 目录下，
// 相对路径会指错地方）。
const fromRoot = (relative) => JSON.stringify(join(ROOT, relative).replace(/\\/g, '/'))

const HARNESS_ENTRY = `
// stub 必须先于应用源码求值，所以它是第一个 import
import './verify-markdown-stub'
import { readFileSync, writeFileSync } from 'node:fs'
import { createState } from ${fromRoot('src/renderer/editor/state.ts')}
import { scanMath, excludedRanges } from ${fromRoot('src/renderer/editor/math-scan.ts')}
import { syntaxTree } from '@codemirror/language'

interface Case { name: string; input: string }
interface Result { name: string; input: string; output: string | null; error: string | null }

/**
 * 打开一份文件再保存，返回落盘的内容。
 *
 * 刻意不创建 EditorView：要证的是字节，而字节的真相在 EditorState 里。view 管排版与
 * 滚动，需要真实布局测量，在 Node 里造不出来，也与保真无关。
 *
 * 行尾按应用的做法处理，不登记成豁免：应用在 takeFrontmatter 里记下文件用的是不是
 * CRLF（main.ts），保存时在 getFileContent 里把正文还原成 CRLF。harness 走同一条路，
 * 所以 Windows 文件的保真也是真验过的。
 */
function roundtripFile(file: string): string {
  const CRLF = '\\r\\n'
  const LF = '\\n'
  const lineEnding = file.includes(CRLF) ? CRLF : LF
  const body = createState(file.split(CRLF).join(LF)).doc.toString()
  return lineEnding === CRLF ? body.split(LF).join(CRLF) : body
}

/** 公式扫描的判定结果，用来验证「价格不会被当成公式、代码里的 $ 不渲染」。 */
function mathProbe(text: string): Array<{ from: number; to: number; code: string; block: boolean }> {
  const state = createState(text)
  return scanMath(text, excludedRanges(text, syntaxTree(state)))
}

async function main(): Promise<void> {
  const [casesPath, resultPath] = process.argv.slice(2)
  const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as Case[]
  const results: Result[] = cases.map((entry) => {
    try {
      return { name: entry.name, input: entry.input, output: roundtripFile(entry.input), error: null }
    } catch (error) {
      return { name: entry.name, input: entry.input, output: null, error: String((error as Error)?.message ?? error) }
    }
  })

  // 公式判定：报告、不判失败，供人核对
  const probes: Record<string, unknown> = {}
  for (const [label, text] of [
    ['price', '价格 $5，成本 $6 的关系。'],
    ['price with cents', '$1,299.99 起'],
    ['price run', '$349 起、$149 和 $599'],
    ['real inline', '公式 $E=mc^2$ 保留。'],
    ['real simple', '$x$'],
    ['block', '$$\\nE = mc^2\\n$$'],
    ['in code fence', '\\\`\\\`\\\`\\n$x$ 不是公式\\n\\\`\\\`\\\`'],
    ['in inline code', '\\\`$x$\\\` 不是公式'],
    ['escaped', '\\\\$5 是转义'],
  ] as Array<[string, string]>) {
    probes[label] = mathProbe(text)
  }
  writeFileSync(resultPath, JSON.stringify({ results, probes }, null, 2))
}

void main()
`

// ─── 主流程 ─────────────────────────────────────────────────────────────────

mkdirSync(CACHE, { recursive: true })
writeFileSync(STUB_FILE, DOM_STUB)
writeFileSync(ENTRY_FILE, HARNESS_ENTRY)
writeFileSync(CASES_FILE, JSON.stringify(CASES.map(([name, input]) => ({ name, input })), null, 2))

try {
  await build({
    entryPoints: [ENTRY_FILE],
    outfile: BUNDLE_FILE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'warning',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
} catch (error) {
  console.error('打包 harness 失败，脚本自身没跑起来（退出码 2）。')
  console.error(String(error?.message ?? error))
  process.exit(REPORT_ONLY ? 0 : 2)
}

const harnessExit = await new Promise((resolve) => {
  const child = spawn(process.execPath, [BUNDLE_FILE, CASES_FILE, RESULT_FILE], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout.on('data', () => {})
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('exit', (code) => resolve({ code: code ?? 0, stderr }))
})

if (harnessExit.code !== 0 || !existsSync(RESULT_FILE)) {
  console.error('harness 执行失败，这不是保真问题（退出码 2）。')
  if (harnessExit.stderr.trim()) console.error(harnessExit.stderr.trim())
  process.exit(REPORT_ONLY ? 0 : 2)
}

let payload
try {
  payload = JSON.parse(readFileSync(RESULT_FILE, 'utf8'))
} catch (error) {
  console.error('读不到 harness 结果，脚本自身没跑起来（退出码 2）。')
  console.error(String(error?.message ?? error))
  process.exit(REPORT_ONLY ? 0 : 2)
}

const { results, probes } = payload

console.log('markdown 往返验收：打开一个文件、不做修改、保存，字节必须一致')
console.log(`用例 ${results.length} 条，已知可接受的归一化 ${KNOWN_NORMALIZATIONS.length} 类`)
console.log('')

const normalize = (text) => text
let same = 0
let normalizedCount = 0
const violations = []

for (const result of results) {
  if (result.error) {
    violations.push(result)
    console.log(`[ERROR] ${result.name}`)
    console.log(`   err: ${result.error}`)
    continue
  }
  if (result.input === result.output) {
    same++
    continue
  }
  const normalized = normalize(result.output) === normalize(result.input)
  console.log(`[DIFF${normalized ? ' known' : ''}] ${result.name}`)
  console.log(`   in : ${JSON.stringify(result.input)}`)
  console.log(`   out: ${JSON.stringify(result.output)}`)
  if (normalized) normalizedCount++
  else violations.push(result)
}

const diff = results.length - same
console.log('')
console.log(`===== ${same} SAME / ${diff} DIFF =====`)
console.log(`      其中 ${normalizedCount} 条命中 KNOWN_NORMALIZATIONS（可接受），${violations.length} 条是违反保真的 bug`)

if (probes) {
  console.log('')
  console.log('公式判定（应当只有真公式被认出）：')
  for (const [label, ranges] of Object.entries(probes)) {
    const list = ranges
    if (!Array.isArray(list)) continue
    const desc = list.length === 0 ? '无（当作普通文字）' : list.map((r) => JSON.stringify(r.code)).join(', ')
    console.log(`  ${label}: ${desc}`)
  }
}

if (violations.length > 0) {
  console.log('')
  console.log('违反保真（用户没动过的字节不许变）：')
  for (const result of violations) {
    if (result.error) console.log(`  - ${result.name}（harness 抛错：${result.error}）`)
    else console.log(`  - ${result.name}: ${JSON.stringify(result.input)} -> ${JSON.stringify(result.output)}`)
  }
}

if (REPORT_ONLY) {
  console.log('')
  console.log('--report：只报告不判失败，退出码 0。')
  process.exit(0)
}

if (violations.length > 0) {
  console.log('')
  console.log(`存在 ${violations.length} 条保真问题，退出码 1。`)
  process.exit(1)
}
process.exit(0)
