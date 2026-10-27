// 直接加载装饰层源码，验解析刷新调度及公式/高亮扫描，不增加产品测试接口。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = new URL('..', import.meta.url).pathname
const { EditorState, ChangeSet } = require('@codemirror/state')
const { markdown } = require('@codemirror/lang-markdown')
const language = require('@codemirror/language')
const timers = []
let scans = 0, exclusions = 0, passed = 0, failed = 0
function check(name, run) {
  try { run(); passed++; console.log('✓ ' + name) }
  catch (error) { failed++; console.error('✗ ' + name + ': ' + error.message) }
}
const cache = new Map()
function load(path) {
  if (cache.has(path)) return cache.get(path)
  let source = readFileSync(path, 'utf8')
  if (path.endsWith('/live-preview.ts')) source += '\nexport { parseRefresh, buildDecorations }'
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText
  const exports = {}
  cache.set(path, exports)
  const localRequire = name => {
    if (name === '@codemirror/language') return { ...language,
      syntaxTree: state => state.testTree ?? language.syntaxTree(state) }
    if (name === './mermaid-bridge') return {}
    if (!name.startsWith('.')) return require(name)
    const value = load(resolve(dirname(path), name + '.ts'))
    if (name !== './math-scan') return value
    return { ...value,
      scanMath: (...args) => { scans++; return value.scanMath(...args) },
      excludedRanges: (...args) => { exclusions++; return value.excludedRanges(...args) },
    }
  }
  vm.runInThisContext(`(function(require,exports,setTimeout){${code}\n})`)(localRequire, exports, callback => timers.push(callback))
  return exports
}
const { parseRefresh, buildDecorations, decorationsRefreshEffect, livePreviewField } =
  load(resolve(root, 'src/renderer/editor/live-preview.ts'))

function refreshCase(name, oldLength, parsed, changes, nextParsed, expected) {
  check(name, () => {
    timers.length = 0
    const state = { testTree: { length: parsed } }
    const view = { state, viewport: { to: 10 }, dom: { isConnected: true }, dispatch(spec) {
      assert(spec.effects.is(decorationsRefreshEffect))
      dispatched++
    } }
    let dispatched = 0
    const plugin = parseRefresh.create(view)
    // 初始化旧实现的记录；初次显示的刷新不计作输入。
    plugin.update({ state, view, changes: ChangeSet.empty(oldLength) })
    while (timers.length) timers.shift()()
    dispatched = 0
    view.state = { testTree: { length: nextParsed } }
    plugin.update({ state: view.state, view, changes: ChangeSet.of(changes, oldLength) })
    while (timers.length) timers.shift()()
    assert.equal(dispatched, expected)
  })
}
refreshCase('普通正文打字不额外刷新', 100, 100, { from: 20, insert: '字' }, 101, 0)
refreshCase('文末打字不额外刷新', 100, 100, { from: 100, insert: '字' }, 101, 0)
refreshCase('普通退格不额外刷新', 100, 100, { from: 20, to: 21 }, 99, 0)
refreshCase('懒解析推进仍刷新', 100, 40, [], 70, 1)
refreshCase('文档增长同时解析推进仍刷新', 100, 40, { from: 20, insert: '字' }, 71, 1)
refreshCase('文档缩短同时解析推进仍刷新', 100, 40, { from: 20, to: 30 }, 60, 1)
refreshCase('解析终点被替换且新树停在插入区内仍刷新', 100, 40, { from: 30, to: 50, insert: '字'.repeat(60) }, 60, 1)
refreshCase('终点前后同时编辑只映射不刷新', 100, 40,
  [{ from: 20, insert: '字字' }, { from: 70, to: 75 }], 42, 0)
refreshCase('终点处插入且解析越过插入区仍刷新', 100, 40, { from: 40, insert: '字字' }, 60, 1)
refreshCase('终点处插入只映射不刷新', 100, 40, { from: 40, insert: '字字' }, 42, 0)
check('首次输入也不额外刷新', () => {
  timers.length = 0
  const view = { state: { testTree: { length: 100 } }, viewport: { to: 10 } }
  const plugin = parseRefresh.create(view)
  view.state = { testTree: { length: 101 } }
  plugin.update({ state: view.state, view, changes: ChangeSet.of({ from: 20, insert: '字' }, 100) })
  assert.equal(timers.length, 0)
})

check('真实懒解析推进派发刷新并补全尾部装饰', () => {
  timers.length = 0
  let state = EditorState.create({ doc: ('正文 **加粗**\n\n## 标题\n\n').repeat(5000),
    extensions: [markdown(), livePreviewField] })
  const initial = language.syntaxTree(state)
  assert(initial.length < state.doc.length, '夹具必须尚未解析完')
  const view = { state, viewport: { to: 10 }, dom: { isConnected: true }, dispatch(spec) {
    effects++
    this.state = this.state.update(spec).state
  } }
  let effects = 0
  const plugin = parseRefresh.create(view)
  plugin.update({ state, view, changes: ChangeSet.empty(state.doc.length) })
  while (timers.length) timers.shift()()
  effects = 0
  assert(language.ensureSyntaxTree(view.state, state.doc.length, 5000))
  const old = view.state
  state = view.state = old.update({}).state
  assert(language.syntaxTree(state).length > initial.length)
  plugin.update({ state, view, changes: ChangeSet.empty(state.doc.length) })
  while (timers.length) timers.shift()()
  assert.equal(effects, 1)
  const tail = state.doc.length - 100
  let headings = 0
  view.state.field(livePreviewField).between(tail, state.doc.length, (_from, _to, value) => {
    if (value.spec.class?.includes('cm-md-atxheading2')) headings++
  })
  assert(headings > 0, '尾部标题必须获得装饰')
})

const fixtures = [
  ['普通正文 **加粗**', [], 0, 0],
  ['$x$ 与 $$y$$', ['x', 'y'], 0, 1],
  ['\\(x^2\\) 与 \\[y^2\\]', ['x^2', 'y^2'], 0, 1],
  ['前文\n\n$$\nx^2\n$$\n\n后文', ['\nx^2\n'], 0, 1],
  ['前文\n\n\\[y^2\\]\n\n后文', ['y^2'], 0, 1],
  ['==高亮==', [], 1, 1],
  ['`$x$ \\(y\\) \\[z\\] ==代码==`', [], 0, 1],
  ['```md\n$x$ \\(y\\) \\[z\\] ==代码==\n```', [], 0, 1],
  ['---\ntitle: $x$ ==属性==\n---\n\n$x$ ==正文==', ['x'], 1, 1],
  ['\\$字面美元 与 \\path 和单个 =', [], 0, 1],
  ['`$code$` 与 $x$ 和 `==代码==` 与 ==正文==', ['x'], 1, 1],
]
for (const [doc, math, highlights, excluded] of fixtures) {
  check('公式/高亮渲染及排除区：' + JSON.stringify(doc), () => {
    const state = EditorState.create({ doc, extensions: [markdown()] })
    scans = exclusions = 0
    const decorations = buildDecorations(state, null)
    const actual = [], marked = []
    for (let c = decorations.iter(); c.value; c.next()) {
      const spec = c.value.spec
      if (spec.widget?.constructor.name === 'MathWidget') actual.push(spec.widget.code)
      if (spec.class === 'cm-md-highlight') marked.push(doc.slice(c.from, c.to))
    }
    assert.deepEqual(actual, math)
    assert.equal(marked.length, highlights)
    assert.equal(exclusions, excluded, '每次构建最多扫描一次排除区')
    assert.equal(scans, /[$\\]/.test(doc) ? 1 : 0, '无公式定界符跳过公式扫描')
  })
}
console.log(`装饰层专项：${passed} 通过，${failed} 失败`)
if (failed) throw new Error('装饰层专项失败')
