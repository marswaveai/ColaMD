// 解析规则的纯 Node 回归：真实编辑器 parser，完整代码跨度里的竖线不参与分格。
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'colamd-table-syntax-'))
try {
  await build({
    stdin: { contents: `export { markdownParser, createState } from './src/renderer/editor/state'; export { parseMarkdownForWord } from './src/main/markdown-for-word'; export { findTextMatches, replaceTextMatches } from './src/renderer/editor/table-editing'; export { tableCodeSpans } from './src/shared/markdown-tables'; export { parser, GFM } from '@lezer/markdown'`, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'parser.mjs'), logLevel: 'silent',
  })
  const { markdownParser, parseMarkdownForWord, createState, findTextMatches, replaceTextMatches, tableCodeSpans, parser, GFM } = await import(pathToFileURL(join(dir, 'parser.mjs')))
  let passed = 0, failed = 0
  const check = (name, success, detail) => {
    if (success) { passed++; console.log(`PASS ${name}`) }
    else { failed++; console.error(`FAIL ${name}: ${JSON.stringify(detail)}`) }
  }
  const rows = text => {
    const result = []
    markdownParser.parse(text).iterate({ enter(node) {
      if (node.name !== 'TableHeader' && node.name !== 'TableRow') return
      const cells = []
      for (let cell = node.node.firstChild; cell; cell = cell.nextSibling) {
        if (cell.name === 'TableCell') cells.push(text.slice(cell.from, cell.to))
      }
      result.push(cells)
    } })
    return result
  }
  const table = value => `| A | B |\n|---|---|\n| ${value} | end |\n`
  const wordRows = text => {
    const result = []
    const inlineText = node => node.value ?? node.children?.map(inlineText).join('') ?? ''
    const visit = node => {
      if (node.type === 'table') result.push(...node.children.map(row => row.children.map(inlineText)))
      else node.children?.forEach(visit)
    }
    visit(parseMarkdownForWord(text))
    return result
  }
  for (let slashes = 0; slashes <= 4; slashes++) {
    const value = '`a' + '\\'.repeat(slashes) + '|b`'
    const actual = rows(table(value))
    check(`代码内 ${slashes} 根反斜杠保持两格及原文`, JSON.stringify(actual) === JSON.stringify([['A', 'B'], [value, 'end']]), actual)
    const word = wordRows(table(value))
    check(`Word 保留 ${slashes} 根反斜杠与竖线`, JSON.stringify(word) === JSON.stringify([['A', 'B'], [value.slice(1, -1), 'end']]), word)
  }
  for (const value of ['``a`|b``', '`a|b|c`', '**`a|b`**', '[`a|b`](url)', '`a|b\\`']) {
    const actual = rows(table(value))
    check(`完整代码跨度 ${value}`, JSON.stringify(actual) === JSON.stringify([['A', 'B'], [value, 'end']]), actual)
  }
  for (const prefix of ['', '> ', '- ']) {
    const text = `${prefix}| \`a|b\` | B |\n${prefix === '- ' ? '  ' : prefix}|---|---|\n${prefix === '- ' ? '  ' : prefix}| x | y |\n`
    const actual = rows(text)
    check(`代码表头与容器 ${JSON.stringify(prefix)}`, actual.length === 2 && actual[0].length === 2 && actual[0][0] === '`a|b`', actual)
  }
  for (const value of ['a\\|b', 'a\\\\\\|b']) {
    const actual = rows(table(value))
    check(`普通文字转义 ${value}`, actual[1]?.length === 2 && actual[1][0] === value, actual)
  }
  const unmatched = rows(table('`a|b'))
  check('未闭合反引号不吞掉分格符', unmatched[1]?.length === 3, unmatched)
  const escaped = rows(table('\\`a|b`'))
  check('被转义的起始反引号不保护竖线', escaped[1]?.length === 3, escaped)
  const fenced = rows('```md\n' + table('`a|b`') + '```\n')
  check('围栏里的表格仍然是代码', fenced.length === 0, fenced)
  for (const [name, text, expected] of [
    ['代码表头', '| `a|b` | c |\n|---|---|\n| x | y |\n', [['a|b','c'],['x','y']]],
    ['引用表格', '> | A | B |\n> |---|---|\n> | `a\\|b` | end |\n', [['A','B'],['a\\|b','end']]],
    ['列表表格', '- | A | B |\n  |---|---|\n  | ``a`|b`` | end |\n', [['A','B'],['a`|b','end']]],
    ['代码两边空格按代码跨度规则处理', table('` a|b `'), [['A','B'],['a|b','end']]],
  ]) {
    const word = wordRows(text)
    check(`Word ${name}`, JSON.stringify(word) === JSON.stringify(expected), word)
  }
  for (const [prefix, continuation] of [['',''], ['> ','> '], ['- ','  '], ['> - ','>   ']]) {
    const text = `${prefix}| [link](https://example.com/\`a|b\`) | B |\n${continuation}|---|---|\n${continuation}| <span title="\`c|d\`">text</span> | end |\n`.replace(/\n/g, prefix === '> - ' ? '\r\n' : '\n')
    const word = wordRows(text)
    const tree = parseMarkdownForWord(text)
    const links = [], html = []
    const visit = node => {
      if (node.type === 'link') links.push(node.url)
      if (node.type === 'html') html.push(node.value)
      node.children?.forEach(visit)
    }
    visit(tree)
    check(`Word 共享分格并保留链接与标签原文 ${JSON.stringify(prefix)}`,
      JSON.stringify(word) === JSON.stringify([['link','B'],['<span title="`c|d`">text</span>','end']]) &&
      links[0] === 'https://example.com/`a|b`' && html[0] === '<span title="`c|d`">', {word,links,html})
  }
  for (const value of ['# 标题', '---', '- 列表', '> 引用', '[引用]: url']) {
    const word = wordRows(table(value))
    check(`Word 格首文字维持行内语义 ${value}`, JSON.stringify(word) === JSON.stringify([['A','B'],[value,'end']]), word)
  }
  for (const [name, text] of [
    ['后置定义', table('[label][id]') + '\n[id]: https://example.com\n'],
    ['前置定义', '[id]: https://example.com\n\n' + table('[label][id]')],
    ['引用内定义', '> | A | B |\n> |---|---|\n> | [label][id] | end |\n>\n> [id]: https://example.com\n'],
  ]) {
    const word = wordRows(text)
    let reference, definition
    const visit = node => {
      if (node.type === 'linkReference') reference = node
      if (node.type === 'definition') definition = node
      node.children?.forEach(visit)
    }
    visit(parseMarkdownForWord(text))
    const at = text.indexOf('[label][id]')
    check(`Word 引用链接保留文档上下文和源码位置 ${name}`,
      JSON.stringify(word) === JSON.stringify([['A','B'],['label','end']]) && reference?.position.start.offset === at &&
      reference.children[0].position.start.offset === at + 1 && definition?.position.start.offset === text.indexOf('[id]:'), {word,reference,definition})
  }
  const literalWord = wordRows(table('  \\[literal\\] and tail\\ \t'))
  check('Word 格边空白、行内转义和末尾反斜杠不跨格', JSON.stringify(literalWord) === JSON.stringify([['A','B'],['[literal] and tail\\','end']]), literalWord)
  const spacedWord = wordRows('| A | B |\n|---|---|\n|   | end |\n| ` a|b ` | tail |\n')
  check('Word 批量行内解析保留空格子与代码空格语义', JSON.stringify(spacedWord) === JSON.stringify([['A','B'],['','end'],['a|b','tail']]), spacedWord)
  const footnoteWord = parseMarkdownForWord(table('[^note]') + '\n[^note]: comment\n')
  check('Word 格内脚注保持既有引用节点', footnoteWord.children[0]?.children?.[1]?.children?.[0]?.children?.[0]?.type === 'footnoteReference', footnoteWord)
  for (const [name, value, query, replacement, expected] of [
    ['同格多次替换竖线', 'axb axb', 'x', '|', 'a\\|b a\\|b'],
    ['代码格多次替换竖线', '`axb axb`', 'x', '|', '`a|b a|b`'],
    ['按显示文字查找转义竖线', 'a\\|b', 'a|b', 'done', 'done'],
    ['只替换字面竖线', 'a\\|b', '|', 'X', 'aXb'],
    ['删除代码反斜杠', '`a\\\\|b`', '\\', '', '`a|b`'],
    ['普通格替换反斜杠后保留字面竖线', 'x\\|b', 'x', '\\', '\\\\\\|b'],
    ['非重叠匹配', 'aaa', 'aa', 'X', 'Xa'],
    ['不改变同格其他字节', '**axb** 和 `axb`', 'x', '|', '**a\\|b** 和 `a|b`'],
    ['大小写转换不会移动中文偏移', 'İ axb 中文', 'x', '|', 'İ a\\|b 中文'],
    ['字面正则字符', 'a.b a+b', '.', '|', 'a\\|b a+b'],
    ['相同替换保留源码', 'axb axb', 'x', 'x', 'axb axb'],
    ['字面反引号按一个字查找和替换', 'a\\`b', '`', 'X', 'aXb'],
  ]) {
    const view = { state: createState(table(value)), dispatch(spec) { this.state = this.state.update(spec).state } }
    const matches = findTextMatches(view.state, query)
    replaceTextMatches(view, matches, replacement)
    check(`单元格替换 ${name}`, view.state.doc.toString() === table(expected), view.state.doc.toString())
  }
  const countState = createState(table('`a|b` and a\\|b'))
  check('查找格线只返回两处可见竖线', findTextMatches(countState, '|').length === 2, findTextMatches(countState, '|'))
  check('渲染查找不匹配分隔行', findTextMatches(countState, '---').length === 0, findTextMatches(countState, '---'))
  check('渲染查找不匹配反引号', findTextMatches(countState, '`').length === 0, findTextMatches(countState, '`'))
  const long = table('`first|cell`') + '\n' + '普通段落。\n\n'.repeat(1500) + table('last\\|cell')
  check('查找覆盖惰性解析之外的表格', findTextMatches(createState(long), '|').length === 2, findTextMatches(createState(long), '|'))
  for (const [name, source, query, replacement, expected] of [
    ['新增反引号不与下一格配对', '| A | B |\n|---|---|\n| axb | `c|d` |\n', 'x', '`', '| A | B |\n|---|---|\n| a\\`b | `c|d` |\n'],
    ['前格未闭合反引号不吞掉新代码格', '| A | B |\n|---|---|\n| a`b | x |\n', 'x', '`c|d`', '| A | B |\n|---|---|\n| a\\`b | `c|d` |\n'],
  ]) {
    const view = { state: createState(source), dispatch(spec) { this.state = this.state.update(spec).state } }
    replaceTextMatches(view, findTextMatches(view.state, query), replacement)
    check(`跨格语法 ${name}`, view.state.doc.toString() === expected, view.state.doc.toString())
  }
  let seed = 137, mismatch = null
  const alphabet = ['a','|','\\','`','``','```',' ']
  for (let sample = 0; sample < 4000 && !mismatch; sample++) {
    let text = ''
    for (let n = 0; n < 30; n++) { seed = (seed * 1664525 + 1013904223) >>> 0; text += alphabet[seed % alphabet.length] }
    const expected = parser.parseInline(text, 0).filter(element => parser.nodeSet.types[element.type].name === 'InlineCode').map(({from,to}) => ({from,to}))
    const actual = tableCodeSpans(text)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatch = {text,actual,expected}
  }
  check('4000 组反引号与反斜杠组合遵循代码跨度配对规则', !mismatch, mismatch)
  const State = createState('').constructor
  const locked = { state: State.create({ doc: table('axb'), extensions: [State.readOnly.of(true)] }), dispatch() { throw new Error('只读状态不允许派发替换') } }
  replaceTextMatches(locked, findTextMatches(locked.state, 'x'), '|')
  check('只读状态查找可用且不替换', locked.state.doc.toString() === table('axb'), locked.state.doc.toString())
  const benchmarkReport = process.argv.find(arg => arg.startsWith('--benchmark-report='))?.split('=').slice(1).join('=')
  if (benchmarkReport) {
    const timed = (run, repeats = 5) => {
      run()
      const times = Array.from({ length: repeats }, () => { const start = performance.now(); run(); return performance.now() - start }).sort((a,b) => a-b)
      return +times[Math.floor(times.length / 2)].toFixed(2)
    }
    const stock = parser.configure(GFM)
    const plain = '| A | B |\n|---|---|\n' + '| ordinary text | 123456 |\n'.repeat(2000)
    const code = '| A | B |\n|---|---|\n' + '| `a\\\\|b` and `c|d` | end |\n'.repeat(2000)
    const report = { node: process.version, rows: 2000,
      plain: { stock_ms: timed(() => stock.parse(plain)), extended_ms: timed(() => markdownParser.parse(plain)) },
      code: { stock_ms: timed(() => stock.parse(code)), extended_ms: timed(() => markdownParser.parse(code)) },
      replace: [], many_rows: [],
    }
    for (const count of [1000, 3000, 6000]) {
      const source = table('axb '.repeat(count))
      const state = createState(source)
      const start = performance.now(), matches = findTextMatches(state, 'x')
      const search_ms = +(performance.now() - start).toFixed(2)
      const view = { state, dispatch(spec) { this.state = this.state.update(spec).state } }
      const replaceStart = performance.now()
      replaceTextMatches(view, matches, '|')
      report.replace.push({ count, search_ms, replace_ms: +(performance.now() - replaceStart).toFixed(2), bytes: source.length })
    }
    const state = createState(code); findTextMatches(state, 'a')
    report.cached_search_ms = timed(() => findTextMatches(state, 'b'))
    for (const count of [2000,6000]) {
      const source = '| A | B |\n|---|---|\n' + '| axb | end |\n'.repeat(count)
      const view = { state: createState(source), dispatch(spec) { this.state = this.state.update(spec).state } }
      const matches = findTextMatches(view.state, 'x'), start = performance.now()
      replaceTextMatches(view, matches, '|')
      report.many_rows.push({ count, replace_ms: +(performance.now() - start).toFixed(2) })
    }
    writeFileSync(benchmarkReport, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
  }
  console.log(JSON.stringify({ passed, failed }))
  process.exitCode = failed ? 1 : 0
} finally {
  rmSync(dir, { recursive: true, force: true })
}
