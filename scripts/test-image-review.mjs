import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = new URL('../', import.meta.url)
const source = (file) => readFileSync(new URL(file, root), 'utf8')
const compile = (code) => ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
// Exercise the production functions without booting Electron or duplicating
// their implementation. Only the application/IPC boundary is replaced.
function functions(file, names) {
  const code = source(file)
  const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
  const selected = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
  assert.equal(selected.length, names.length)
  return selected.map((node) => node.getText(ast)).join('\n')
}
function moduleFrom(file, imports = {}, globals = {}) {
  const exports = {}
  const context = vm.createContext({ exports, require: (id) => imports[id] ?? require(id), ...globals })
  vm.runInContext(compile(source(file)), context)
  return { exports, context }
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
const paths = vm.createContext({ ...path, pathToFileURL: url.pathToFileURL, fileURLToPath: url.fileURLToPath })
vm.runInContext(compile(functions('src/main/index.ts', [
  'localImageUrl', 'resolveImagePaths', 'sourceImageUrl', 'markdownImagePath', 'restoreImagePaths',
])), paths)

function autosave(wait, save) {
  const calls = [], errors = []
  const context = vm.createContext({
    dirty: true, currentFilePath: '/docs/a.md', documentRevision: 1,
    externalConflictPending: false, saveQueue: Promise.resolve(), content: '![](blob:pending)',
    whenImageWritesSettled: wait,
    console: { error: (...args) => errors.push(args) },
    window: { electronAPI: { saveFile: async (...args) => { calls.push(args); return save ? save(...args) : args[1] } } },
  })
  vm.runInContext(compile(`
    function getContent() { return content }
    function clearDirty() { dirty = false }
    function showSaveStatus() {}
    ${functions('src/renderer/main.ts', ['enqueueSave', 'runAutosave'])}
  `), context)
  return { context, calls, errors }
}

test('autosave waits beyond its interval and persists only the final image reference', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'colamd-autosave-'))
  try {
    const pending = deferred()
    const { context: c, calls } = autosave(() => pending.promise, async (content, file) => {
      await writeFile(file, paths.restoreImagePaths(content, file)); return file
    })
    c.currentFilePath = path.join(dir, '文档 空格.md')
    const run = c.runAutosave()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal(calls.length, 0)
    c.content = `![](${url.pathToFileURL(path.join(dir, 'assets', 'image.png')).href})`
    c.documentRevision++
    pending.resolve()
    await run
    assert.equal(await readFile(c.currentFilePath, 'utf8'), '![](assets/image.png)')
    assert.equal(c.dirty, false)
    assert.equal(calls[0][2], false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

for (const [name, change] of [
  ['file switch', (c) => { c.currentFilePath = '/docs/b.md' }],
  ['external conflict', (c) => { c.externalConflictPending = true }],
  ['already saved', (c) => { c.dirty = false }],
]) test(`autosave cancels after waiting: ${name}`, async () => {
  const pending = deferred()
  const { context: c, calls } = autosave(() => pending.promise)
  const run = c.runAutosave()
  await tick(); change(c); pending.resolve(); await run
  assert.equal(calls.length, 0)
})

test('rejected image wait leaves the document dirty and the save queue usable', async () => {
  const pending = deferred()
  const { context: c, calls, errors } = autosave(() => pending.promise)
  const run = c.runAutosave()
  await tick(); pending.reject(new Error('disk full')); await run
  assert.equal(calls.length, 0); assert.equal(c.dirty, true); assert.equal(errors.length, 1)
  c.whenImageWritesSettled = async () => {}
  c.content = 'image failed; placeholder removed'
  await c.runAutosave()
  assert.equal(calls.length, 1)
})

test('editing during disk save preserves dirty status', async () => {
  const disk = deferred()
  const { context: c } = autosave(async () => {}, () => disk.promise)
  c.content = 'saved snapshot'
  const run = c.runAutosave()
  await tick(); c.documentRevision++; c.content = 'new edit'; disk.resolve(c.currentFilePath); await run
  assert.equal(c.dirty, true)
})

test('queued autosaves capture current content only when their turn begins', async () => {
  const priorSave = deferred()
  const { context: c, calls } = autosave(async () => {})
  c.saveQueue = priorSave.promise
  const first = c.runAutosave(), second = c.runAutosave()
  c.content = 'latest safe content'; c.documentRevision++
  priorSave.resolve(); await Promise.all([first, second])
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'latest safe content')
})

function pasteHarness(hooks, api) {
  const language = moduleFrom('src/renderer/ui-language.ts', {}, { navigator: { language: 'en' } }).exports
  const core = moduleFrom('src/renderer/editor/image/core.ts', {}, { window: { electronAPI: api }, Uint8Array }).exports
  core.configureImageExperience(hooks)
  return moduleFrom('src/renderer/editor/image/paste.ts', {
    '../../ui-language': language, './core': core,
    '@milkdown/kit/utils': { $prose: (factory) => factory },
    '@milkdown/kit/prose/state': { Plugin: class { constructor(spec) { this.spec = spec } } },
  }, { window: { electronAPI: api }, HTMLInputElement: class {}, URL, File, Uint8Array })
}

test('image-write barrier includes new writes added while draining', async () => {
  const { context: c, exports: api } = pasteHarness({}, {})
  const first = deferred(), second = deferred()
  c.trackImageWrite(first.promise)
  let done = false
  const settled = api.whenImageWritesSettled().then(() => { done = true })
  c.trackImageWrite(second.promise); first.resolve(); await tick()
  assert.equal(done, false)
  second.resolve(); await settled; assert.equal(done, true)
})

for (const route of ['paste', 'drop', 'picker']) test(`source ${route}: file URL renders and round-trips to a portable path`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'colamd-中文 空格-'))
  try {
    const docPath = path.join(dir, '文档.md')
    const { exports: images } = moduleFrom('src/main/images.ts', {}, { Buffer })
    const bytes = Buffer.from('test image bytes')
    const picked = path.join(dir, '图片 空格.png'); await writeFile(picked, bytes)
    const inserted = deferred()
    const { context: c, exports: api } = pasteHarness({
      isSourceMode: () => true, ensureDocumentSaved: async () => docPath,
      insertSourceText: inserted.resolve, notify: (message) => assert.fail(message),
    }, {
      saveImage: (payload) => images.saveImageAsset({ ...payload, docPath }),
      pickImages: async () => [picked],
    })
    const transfer = { files: [new File([bytes], '图片.png', { type: 'image/png' })] }
    const event = { target: {}, clipboardData: transfer, dataTransfer: transfer, preventDefault() {}, stopPropagation() {} }
    if (route === 'picker') await api.insertImagesFromPicker()
    else if (route === 'paste') c.onPaste(event)
    else c.onDrop(event)
    const markdown = await inserted.promise
    assert.match(markdown, /^!\[\]\(file:\/\//)
    const imageUrl = markdown.slice(4, -1)
    assert.deepEqual(await readFile(url.fileURLToPath(imageUrl)), bytes)
    const disk = paths.restoreImagePaths(markdown, docPath)
    assert.match(disk, /^!\[\]\(assets\/[a-f0-9]+\.png\)$/)
    assert.equal(paths.resolveImagePaths(disk, docPath), markdown)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('language subscribers only run on change and can unsubscribe', () => {
  const { exports: lang } = moduleFrom('src/renderer/ui-language.ts', {}, { navigator: { language: 'zh-CN' } })
  let count = 0
  const stop = lang.onUiLanguageChanged(() => { count++; assert.equal(lang.isChinese(), false) })
  lang.setUiLanguage('zh'); assert.equal(count, 0)
  lang.setUiLanguage('en'); assert.equal(count, 1)
  lang.setUiLanguage('en'); assert.equal(count, 1)
  stop(); lang.setUiLanguage('zh'); assert.equal(count, 1)
})
