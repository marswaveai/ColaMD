#!/usr/bin/env node
// PDF 导出的真机验证：驱动真实的导出通道，检查纸上是不是**整篇**。
//
// 为什么需要它：编辑器只为视口内的行建 DOM（长文档在屏幕上只有十几行是真的元素），
// 而 PDF 打印的就是这个窗口。少了「导出前把整篇渲染出来」这一步，长文档导出的只有
// 当前视口那一屏；页数、逐行唯一标记与最后一页正文一起验，避免漏尾或空末页。
//
// 用法: npm run verify:export-pdf（先 npm run build）
// 窗口放在屏幕外，测试不占用屏幕。
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

const APP = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
assertBuildFresh()
const { dir: WORK, udd } = verifyWorkdir('export-pdf')
const EVIDENCE = mkdtempSync(join(tmpdir(), 'colamd-pdf-export-evidence-'))
const TAIL = 'COLAMD_UNIQUE_DOCUMENT_END_20261025'
for (const tool of ['pdfinfo', 'pdftotext', 'pdftoppm']) execFileSync(tool, ['-v'], { stdio: 'pipe' })

/** 三百行正文：屏幕上一屏只装得下二十来行，所以「只有视口」和「整篇」的页数差得很远。 */
const ROWS = 300
/** 一屏内容最多两页；整篇 300 行按 A4 排下来不会少于这个数。 */
const MIN_PAGES = 5
// Chromium 的 A4 纸张会量化到内部单位，不能拿理想的 297mm 当作精确像素边界。
// 从同一真实打印通道产生的 PDF MediaBox 计算可用高度，再验相邻的整数 CSS 像素。
let printableHeight

function fixture() {
  const lines = ['# 导出验证', '']
  for (let i = 1; i <= ROWS; i++) {
    lines.push(`COLAMD_ROW_${String(i).padStart(4, '0')} 第 ${i} 行：这一段用来把文档撑长，检查导出的 PDF 里是不是整篇都在。`)
    lines.push('')
  }
  lines.push(TAIL)
  return lines.join('\n')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const msgId = ++id
          pending.set(msgId, { res, rej })
          ws.send(JSON.stringify({ id: msgId, method, params }))
        })
      },
      close: () => ws.close()
    }))
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      }
    })
    ws.addEventListener('error', () => reject(new Error(`连接不上 ${url}`)))
    ws.addEventListener('close', () => {
      for (const { rej } of pending.values()) rej(new Error(`调试连接已关闭：${url}`))
      pending.clear()
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitTarget(port, predicate, ms = 30000) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const hit = list.find(predicate)
      if (hit) return hit
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('等不到调试目标')
}

function evaluate(client, expression) {
  return client.send('Runtime.evaluate', {
    expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true
  }).then((result) => {
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400))
    return result.result?.value
  })
}

// 页数与每页正文分别取证，不能用 PDF 对象计数代替内容完整性。
function inspectPDF(file, testCase) {
  const info = execFileSync('pdfinfo', [file], { encoding: 'utf8' })
  const count = Number(info.match(/^Pages:\s+(\d+)/m)?.[1])
  if (!(count > 0)) throw new Error('pdfinfo 没有返回有效页数')
  const paperHeight = Number(info.match(/^Page size:\s+[\d.]+ x ([\d.]+) pts/m)?.[1])
  if (!(paperHeight > 0)) throw new Error('pdfinfo 没有返回有效纸张高度')
  printableHeight = Math.floor(paperHeight * 96 / 72 - 40 * 96 / 25.4)
  const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
  const pages = text.split('\f')
  if (pages.at(-1)?.trim() === '') pages.pop() // Poppler 最后一个分页符后的空字段不是一页
  const analysis = { count, info, pages, bytes: readFileSync(file).length, testCase }
  writeFileSync(`${file}.analysis.json`, JSON.stringify(analysis, null, 2))
  execFileSync('pdftoppm', ['-f', String(count), '-l', String(count), '-scale-to', '1200', '-png', '-singlefile', file, `${file}-last`])
  const problems = []
  if (pages.length !== count) problems.push(`文本页数 ${pages.length} 与 pdfinfo ${count} 不同`)
  pages.forEach((page, index) => { if (!page.trim()) problems.push(`第 ${index + 1} 页无正文`) })
  if (testCase.name === 'long') {
    if (count < MIN_PAGES) problems.push(`长文只有 ${count} 页`)
    if (text.split(TAIL).length - 1 !== 1 || !pages.at(-1)?.includes(TAIL)) problems.push('唯一尾标记必须恰好出现一次且在最后一页')
    for (let row = 1; row <= ROWS; row++) {
      const marker = `COLAMD_ROW_${String(row).padStart(4, '0')}`
      if (text.split(marker).length - 1 !== 1) problems.push(`${marker} 缺失或重复`)
    }
  } else {
    if (count !== testCase.expectedPages) problems.push(`边界夹具应为 ${testCase.expectedPages} 页，实际 ${count} 页`)
    if (text.split('BOUNDARY_END').length - 1 !== 1 || !pages.at(-1)?.includes('BOUNDARY_END')) problems.push('边界尾标记缺失、重复或不在最后一页')
  }
  if (problems.length) throw new Error(problems.join('；'))
  console.log(`✓ ${testCase.name}：${count} 页，每页有正文，尾页证据已保存`)
}

async function runCase(testCase) {
  mkdirSync(WORK, { recursive: true })
  const source = join(EVIDENCE, `${testCase.name}.md`)
  const out = join(EVIDENCE, `${testCase.name}.pdf`)
  writeFileSync(source, fixture(), 'utf8')

  const port = 9900 + Math.floor(Math.random() * 60)
  const inspect = port + 1000
  const log = openSync(join(EVIDENCE, `${testCase.name}-electron.log`), 'a')
  spawn('npx', ['electron', 'scripts/offscreen-window.cjs', source, `--user-data-dir=${udd}`,
    '--force-color-profile=srgb',
    `--remote-debugging-port=${port}`, `--inspect=${inspect}`
  ], { cwd: APP, stdio: ['ignore', log, log], detached: true })
  closeSync(log)

  try {
    const page = await waitTarget(port, (t) => t.type === 'page' && /index\.html/.test(t.url))
    const mainTarget = await waitTarget(inspect, (t) => t.type === 'node')
    const renderer = await connect(page.webSocketDebuggerUrl)
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const main = await connect(mainTarget.webSocketDebuggerUrl)

    // 测试不许占用屏幕：连上就藏好，并且别让导出流程把窗口叫回来
    await evaluate(main, `(() => {
      const { BrowserWindow, dialog } = require('electron')
      BrowserWindow.prototype.show = function () {}
      BrowserWindow.prototype.focus = function () {}
      BrowserWindow.getAllWindows().forEach((win) => { win.setPosition(-4000, -4000) })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(out)} })
      globalThis.__exportError = null
      dialog.showMessageBox = async (win, options) => { globalThis.__exportError = options; return { response: 0 } }
      return true
    })()`)

    for (let i = 0; i < 80; i++) {
      if (String(await evaluate(renderer, 'document.title')).includes(testCase.name)) break
      await sleep(250)
    }
    // 文档要先渲染出来：等编辑器里出现正文行
    for (let i = 0; i < 80; i++) {
      const lines = await evaluate(renderer, `document.querySelectorAll('#editor .cm-line').length`)
      if (Number(lines) > 5) break
      await sleep(250)
    }

    if (testCase.themeCSS) {
      await evaluate(main, `require('electron').BrowserWindow.getAllWindows()[0].webContents.send('set-custom-css', ${JSON.stringify(testCase.themeCSS)})`)
      await evaluate(renderer, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    }

    if (testCase.name !== 'long') {
      await evaluate(main, `(() => {
        const { BrowserWindow } = require('electron')
        const wc = BrowserWindow.getAllWindows()[0].webContents
        const original = wc.printToPDF.bind(wc)
        wc.printToPDF = async (options) => {
          globalThis.__boundaryGeometry = await wc.executeJavaScript(${JSON.stringify(`(async () => {
            // 打印边界夹具只替换隔离窗口的 DOM 快照，不让 CodeMirror 的输入观察器
            // 把定高样本重新读成一行正文；长文用例仍走真实编辑器的完整渲染。
            const originalContent = document.querySelector('#editor .cm-content')
            const content = originalContent.cloneNode(false)
            originalContent.replaceWith(content)
            // A4 297mm，产品上下页边距各 20mm。保留原始 padding-only 样本的底部留白。
            const height = ${printableHeight} + ${testCase.delta}
            content.style.setProperty('padding-top', '0px', 'important')
            if (!${!!testCase.keepPadding}) content.style.setProperty('padding-bottom', '0px', 'important')
            // 尾标记必须在正常排版流里，才能像真实正文一样参与分页。
            // 绝对定位的 1px 字形会溢出页面却不触发分页，不能用它代表正文完整性。
            content.innerHTML = '<div style="margin:0;padding:0"><div style="height:' + (height - 20) + 'px;margin:0;padding:0">BOUNDARY_START</div><div style="height:20px;line-height:20px;font-size:16px;break-inside:avoid;margin:0;padding:0">BOUNDARY_END</div></div>'
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            return { requestedHeight: height, contentHeight: content.getBoundingClientRect().height, paddingBottom: getComputedStyle(content).paddingBottom, dpr: devicePixelRatio }
          })()`)} )
          return original(options)
        }
      })()`)
    }
    // 菜单调用的同一个 IPC API；等 Promise 完成，避免文件刚创建还没写完就读它。
    await evaluate(renderer, `(() => {
      window.__pdfResult = null
      window.electronAPI.exportPDF().then(ok => { window.__pdfResult = { ok } }, error => { window.__pdfResult = { ok: false, error: String(error) } })
    })()`)
    let completed
    for (let i = 0; i < 480; i++) {
      completed = await evaluate(renderer, 'window.__pdfResult')
      if (completed) break
      await sleep(250)
    }
    if (!completed?.ok || !existsSync(out)) throw new Error(`PDF 未完成：${JSON.stringify(completed)}`)

    const geometry = await evaluate(main, 'globalThis.__boundaryGeometry ?? null')
    writeFileSync(`${out}.geometry.json`, JSON.stringify(geometry, null, 2))
    renderer.close()
    main.close()
    inspectPDF(out, testCase)
  } finally {
    stopVerifyApp(udd)
    await sleep(300)
  }
}

console.log(`证据目录 ${EVIDENCE}`)
let failures = 0
for (const testCase of [
  { name: 'long' },
  { name: 'boundary-before', delta: -1, expectedPages: 1 },
  { name: 'boundary-exact', delta: 0, expectedPages: 1 },
  // 让真实文字行落到下一页。只多 1px 的行盒尾隙是空白，并非正文越界；
  // 图像的精确 ±1px 切片边界另由 verify-image-export-contract 覆盖。
  { name: 'boundary-after', delta: 40, expectedPages: 2 },
  { name: 'padding-only', delta: -20, keepPadding: true, expectedPages: 1 },
  ...['#editor', '#editor .cm-content'].flatMap(selector => ['padding-bottom', 'margin-bottom'].map(property => ({
    name: `custom-${selector === '#editor' ? 'editor' : 'content'}-${property}`,
    delta: -20, keepPadding: true, expectedPages: 1,
    themeCSS: `body.theme-custom ${selector} { ${property}: 200px !important; }`
  })))
]) {
  try { await runCase(testCase) }
  catch (error) {
    failures++
    writeFileSync(join(EVIDENCE, `${testCase.name}-error.txt`), error.stack ?? String(error))
    console.error(`✗ ${testCase.name} ${error.message}`)
  }
}
process.exitCode = failures ? 1 : 0
