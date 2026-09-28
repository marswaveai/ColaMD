#!/usr/bin/env node
// Run after npm run build. --unit skips the isolated Electron window.
// The harness uses its own home/userData and never opens the user's documents.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { build, transform } from 'esbuild'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = mkdtempSync(join(tmpdir(), 'colamd-verify-links-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`) }

async function unitChecks() {
  for (const [name, entry] of [['paths', 'src/main/markdown-link.ts'], ['headings', 'src/renderer/editor/heading-anchor.ts']]) {
    await build({ entryPoints: [join(ROOT, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: join(WORK, `${name}.cjs`) })
  }
  const { resolveMarkdownLink } = require(join(WORK, 'paths.cjs'))
  const { headingAnchorLine } = require(join(WORK, 'headings.cjs'))
  const source = join(WORK, 'notes', 'source.md')
  for (const [href, expected] of [
    ['01-索引.md', join(WORK, 'notes', '01-索引.md')],
    ['./中文%20空格.md', join(WORK, 'notes', '中文 空格.md')],
    ['../parent.MD', join(WORK, 'parent.MD')],
    ['child/next.markdown', join(WORK, 'notes', 'child', 'next.markdown')],
    ['hash%23percent%25.md', join(WORK, 'notes', 'hash#percent%.md')],
    [pathToFileURL(join(WORK, '中文 空格.md')).href, join(WORK, '中文 空格.md')],
    [join(WORK, 'absolute.md'), join(WORK, 'absolute.md')],
  ]) check(`resolve ${href}`, () => assert.equal(resolveMarkdownLink(href, source).path, expected))
  check('fragment stays separate', () => assert.equal(resolveMarkdownLink('next.md#中文', source).fragment, '中文'))
  for (const href of ['next.md:147', './中文%20空格.md:147', pathToFileURL(join(WORK, 'next.md')).href + ':147', join(WORK, 'next.md') + ':147']) {
    check(`source line ${href}`, () => {
      const link = resolveMarkdownLink(href, source)
      assert.equal(link.line, 147)
      assert(link.path.endsWith('.md'))
    })
  }
  check('line and heading remain separate', () => {
    const link = resolveMarkdownLink('next.md:147#heading', source)
    assert.equal(link.line, 147); assert.equal(link.fragment, 'heading')
  })
  check('encoded filename colon is not a line suffix', () => assert.equal(resolveMarkdownLink('part%3A147.md', source).line, undefined))
  for (const href of ['next.md:0', 'next.md:9007199254740992', 'next.md:-1', 'next.md:abc']) {
    check(`reject invalid line ${href}`, () => assert.equal(resolveMarkdownLink(href, source), null))
  }
  for (const href of ['#local', 'https://example.com', 'javascript:alert(1)', 'data:text/html,hi', 'run.exe']) {
    check(`reject non-Markdown target ${href}`, () => assert.equal(resolveMarkdownLink(href, source), null))
  }
  check('untitled relative link', () => assert.equal(resolveMarkdownLink('next.md', null), null))
  check('invalid percent encoding', () => assert.throws(() => resolveMarkdownLink('bad%ZZ.md', source)))
  const md = '# **中文 标题**\n\n```md\n# Fake\n```\n\n## Repeat\n\n## Repeat\n\nSetext\n======\n'
  for (const [fragment, expected] of [['%E4%B8%AD%E6%96%87-%E6%A0%87%E9%A2%98', 0], ['fake', null], ['repeat', 6], ['repeat-1', 8], ['setext', 10], ['absent', null]]) {
    check(`heading ${fragment}`, () => assert.equal(headingAnchorLine(md, fragment), expected))
  }
  // Exercise the real tab opener with a failed save, not a copy of its logic.
  const code = readFileSync(join(ROOT, 'src/renderer/main.ts'), 'utf8')
  const start = code.indexOf('async function openFileInNewTab(')
  const end = code.indexOf('\n// Closing several tabs', start)
  const { code: compiled } = await transform(code.slice(start, end), { loader: 'ts' })
  const current = { filePath: source, dirty: true }
  let opens = 0
  const context = { tabs: [current], activeTab: () => current, openNewTab: async () => {}, window: { electronAPI: { openSibling: async () => { opens++ } } } }
  vm.runInNewContext(compiled, context)
  await context.openFileInNewTab(join(WORK, 'other.md'))
  check('failed save preserves current tab', () => { assert.equal(current.filePath, source); assert.equal(opens, 0) })
}

async function connect(port) {
  let page
  for (let i = 0; i < 100; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page' && p.url.includes('index.html')) } catch { /* starting */ }
    if (page) break
    await sleep(200)
  }
  assert(page, 'Electron renderer did not start')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await once(ws, 'open')
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data), item = pending.get(msg.id)
    if (!item) return
    pending.delete(msg.id); clearTimeout(item.timer)
    msg.error ? item.reject(new Error(JSON.stringify(msg.error))) : item.resolve(msg.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`Timeout: ${method}`)) }, 10000)
    pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params }))
  })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  return { send, evaluate, close: () => ws.close() }
}

async function runtimeChecks() {
  const notes = join(WORK, 'notes'), home = join(WORK, 'home'), profile = join(WORK, 'profile')
  for (const dir of [notes, join(notes, 'child'), home, profile]) mkdirSync(dir, { recursive: true })
  const source = join(notes, 'source.md'), target = join(notes, '中文 空格.md'), childFile = join(notes, 'child', 'child.md')
  const lineFile = join(notes, 'lines.md'), largeFile = join(notes, 'large.md')
  const lineText = ['---', 'title: Lines', '---', ...Array.from({ length: 143 }, (_, i) => `Paragraph ${i}.`), 'LINE_147_TARGET', 'Last line.'].join('\r\n')
  const largeText = [...Array.from({ length: 146 }, () => 'Long wrapped paragraph. '.repeat(180)), 'LARGE_147_TARGET', 'Last line.'].join('\n')
  const targetText = '# Destination\n\n' + 'Paragraph.\n\n'.repeat(100) + '## 目标标题\n\nTail.\n'
  const sourceText = '# Source\n\n[相对链接](中文%20空格.md)\n\n[子目录](child/child.md)\n\n[标题](中文%20空格.md#目标标题)\n\n' +
    `[行号](lines.md:147)\n\n[文件行号](${pathToFileURL(lineFile).href}:147)\n\n[源码行号](large.md:147)\n\n[越界行号](lines.md:9999)\n\n` +
    `[File URL](${pathToFileURL(target).href})\n\n[网页](https://example.com)\n\n[缺失](missing.md)\n\n[文内](#source)\n`
  writeFileSync(source, sourceText); writeFileSync(target, targetText); writeFileSync(childFile, '# Child\n\n[上级](../source.md)\n')
  writeFileSync(lineFile, lineText); writeFileSync(largeFile, largeText)
  const before = new Map([source, target, childFile, lineFile, largeFile].map(file => [file, { bytes: readFileSync(file), mtime: statSync(file).mtimeMs }]))
  const events = join(WORK, 'events.jsonl'), harness = join(WORK, 'main.cjs')
  const port = 18000 + Math.floor(Math.random() * 2000)
  // Stub only OS browser launching/error dialogs; real IPC, file IO and tab UI run.
  writeFileSync(harness, `const { app, shell, dialog } = require('electron');
    const fs = require('fs');
    app.setPath('home', ${JSON.stringify(home)}); app.setPath('userData', ${JSON.stringify(profile)});
    shell.openExternal = async url => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({external:url})+'\\n');
    dialog.showMessageBox = async (...args) => { fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({error:args.at(-1).message})+'\\n'); return {response:0}; };
    process.argv = [process.execPath, ${JSON.stringify(ROOT)}, ${JSON.stringify(source)}];
    require(${JSON.stringify(join(ROOT, 'dist/main/index.js'))});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const proc = spawn(require('electron'), [harness, `--remote-debugging-port=${port}`], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; proc.stdout.on('data', x => { output += x }); proc.stderr.on('data', x => { output += x })
  let client
  try {
    client = await connect(port)
    const { send, evaluate } = client
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const wait = async (expression, label) => {
      for (let i = 0; i < 80; i++) { if (await evaluate(expression)) return; await sleep(100) }
      throw new Error(`Timed out: ${label}`)
    }
    await wait(`document.title==='source.md' && !!document.querySelector('[data-href]')`, 'source loaded')
    const openSource = async () => {
      await evaluate(`window.electronAPI.openExternal(${JSON.stringify(source)})`)
      await wait(`document.title==='source.md'`, 'return to source')
      await sleep(150)
    }
    const click = async (label, modifiers = 2) => {
      const point = await evaluate(`(() => {
        const a=[...document.querySelectorAll('#editor [data-href], #editor a[href]')].find(a=>a.textContent===${JSON.stringify(label)});
        if(!a)return null; a.scrollIntoView({block:'center',behavior:'instant'});
        const r=[...a.getClientRects()].find(r=>r.width>2&&r.height>2);
        return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null;
      })()`)
      assert(point, `Link not rendered: ${label}`)
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1, modifiers })
    }
    await click('标题')
    await wait(`document.title==='中文 空格.md' && [...document.querySelectorAll('.cm-line')].some(e=>e.textContent.includes('目标标题')&&e.getBoundingClientRect().y>=0&&e.getBoundingClientRect().bottom<innerHeight)`, 'heading in a newly opened document')
    check('Ctrl+click opens a new file at an offscreen heading', () => {})
    await openSource(); await click('相对链接')
    await wait(`document.title==='中文 空格.md'`, 'Ctrl+click local link')
    check('Ctrl+click opens a Chinese/space filename', () => {})
    const count = await evaluate(`document.querySelectorAll('.tab-entry').length`)
    await openSource(); await click('相对链接', 4)
    await wait(`document.title==='中文 空格.md'`, 'Meta+click existing link')
    const nextCount = await evaluate(`document.querySelectorAll('.tab-entry').length`)
    check('Meta+click reuses an existing tab', () => assert.equal(nextCount, count))
    await openSource(); await click('子目录')
    await wait(`document.title==='child.md'`, 'child')
    await click('上级'); await wait(`document.title==='source.md'`, 'parent')
    check('child and parent directories', () => {})
    await click('标题')
    await wait(`document.title==='中文 空格.md' && [...document.querySelectorAll('.cm-line')].some(e=>e.textContent.includes('目标标题')&&e.getBoundingClientRect().y>=0&&e.getBoundingClientRect().bottom<innerHeight)`, 'offscreen heading')
    check('cross-file heading outside the initial viewport', () => {})
    await openSource(); await click('File URL'); await wait(`document.title==='中文 空格.md'`, 'file URL')
    check('file URL', () => {})
    for (const label of ['行号', '文件行号']) {
      await openSource(); await click(label)
      await wait(`document.title==='lines.md' && document.querySelector('.cm-md-jump-flash')?.textContent==='LINE_147_TARGET'`, label)
      check(`${label}: exact line with CRLF and frontmatter`, () => {})
    }
    await openSource(); await click('越界行号')
    await wait(`document.title==='lines.md' && document.querySelector('.cm-md-jump-flash')?.textContent==='Last line.'`, 'line past EOF')
    check('line past EOF clamps to last line', () => {})
    await openSource(); await click('源码行号')
    await wait(`(() => { const s=document.querySelector('#source-editor'); return document.title==='large.md' && s.classList.contains('visible') && s.value.slice(s.selectionStart,s.selectionEnd)==='LARGE_147_TARGET' && s.scrollTop>0; })()`, 'source mode line')
    check('large source document selects line after wrapped paragraphs', () => {})
    await openSource(); await click('网页'); await sleep(150)
    check('web link still uses the OS browser', () => assert.match(readFileSync(events, 'utf8'), /"external":"https:\/\/example.com"/))
    await openSource(); await click('缺失'); await sleep(200)
    check('missing file reports an error', () => assert.match(readFileSync(events, 'utf8'), /"error":/))
    assert.equal(await evaluate('document.title'), 'source.md')
    await openSource(); await click('文内', 0)
    await wait(`!!document.querySelector('.cm-md-jump-flash')`, 'in-document heading')
    check('in-document anchor', () => {})
    for (const [file, old] of before) check(`navigation preserves ${fileURLToPath(pathToFileURL(file)).split(/[\\/]/).pop()}`, () => {
      assert.deepEqual(readFileSync(file), old.bytes); assert.equal(statSync(file).mtimeMs, old.mtime)
    })
    await evaluate('window.close()')
  } catch (error) {
    if (client) console.error(await client.evaluate(`JSON.stringify({title:document.title,tabs:[...document.querySelectorAll('.tab-entry')].map(x=>x.textContent)})`))
    console.error(output.slice(-2000)); throw error
  } finally {
    client?.close()
    if (proc.exitCode === null) {
      proc.kill()
      await Promise.race([once(proc, 'exit'), sleep(5000)])
    }
  }
}

try {
  await unitChecks()
  if (!process.argv.includes('--unit')) await runtimeChecks()
  console.log(`\n${passed} checks passed`)
} finally {
  rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
