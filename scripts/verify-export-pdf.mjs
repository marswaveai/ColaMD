#!/usr/bin/env node
// PDF 导出的真机验证：驱动真实的导出通道，检查纸上是不是**整篇**。
//
// 为什么需要它：编辑器只为视口内的行建 DOM（长文档在屏幕上只有十几行是真的元素），
// 而 PDF 打印的就是这个窗口。少了「导出前把整篇渲染出来」这一步，长文档导出的只有
// 当前视口那一屏（2026-09-26 报的「长文档只渲染了前面」）。页数是最直接的判据：
// 一屏的内容只够一两页，整篇会摊成很多页。
//
// 用法: npm run verify:export-pdf（先 npm run build）
// 窗口放在屏幕外，测试不占用屏幕。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const WORK = join(homedir(), 'Library', 'Caches', `colamd-verify-pdf-${Date.now()}`)

/** 三百行正文：屏幕上一屏只装得下二十来行，所以「只有视口」和「整篇」的页数差得很远。 */
const ROWS = 300
/** 一屏内容最多两页；整篇 300 行按 A4 排下来不会少于这个数。 */
const MIN_PAGES = 5

function fixture() {
  const lines = ['# 导出验证', '']
  for (let i = 1; i <= ROWS; i++) {
    lines.push(`第 ${i} 行：这一段用来把文档撑长，检查导出的 PDF 里是不是整篇都在。`)
    lines.push('')
  }
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

/** PDF 里的页数。Chromium 把页对象写成明文的 /Type /Page，不压缩。 */
function pageCount(file) {
  const raw = readFileSync(file).toString('latin1')
  const pages = (raw.match(/\/Type\s*\/Page(?![s])/g) ?? []).length
  const declared = Number((raw.match(/\/Count\s+(\d+)/) ?? [])[1] ?? 0)
  return { pages, declared, bytes: raw.length }
}

async function main() {
  mkdirSync(WORK, { recursive: true })
  const source = join(WORK, 'long.md')
  const out = join(WORK, 'long.pdf')
  writeFileSync(source, fixture(), 'utf8')

  const port = 9900 + Math.floor(Math.random() * 60)
  const inspect = port + 1000
  const child = spawn('npx', ['electron', '.', source, `--user-data-dir=${join(WORK, 'udd')}`,
    '--window-position=-4000,-4000', '--force-color-profile=srgb',
    `--remote-debugging-port=${port}`, `--inspect=${inspect}`
  ], { cwd: APP, stdio: 'ignore', detached: true })

  try {
    const page = await waitTarget(port, (t) => t.type === 'page' && /index\.html/.test(t.url))
    const mainTarget = await waitTarget(inspect, (t) => t.type === 'node')
    const renderer = await connect(page.webSocketDebuggerUrl)
    const main = await connect(mainTarget.webSocketDebuggerUrl)

    // 测试不许占用屏幕：连上就藏好，并且别让导出流程把窗口叫回来
    await evaluate(main, `(() => {
      const { BrowserWindow, dialog } = require('electron')
      BrowserWindow.prototype.show = function () {}
      BrowserWindow.prototype.focus = function () {}
      BrowserWindow.getAllWindows().forEach((win) => { win.setPosition(-4000, -4000); win.hide() })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(out)} })
      globalThis.__exportError = null
      dialog.showMessageBox = async (win, options) => { globalThis.__exportError = options; return { response: 0 } }
      return true
    })()`)

    for (let i = 0; i < 80; i++) {
      if (String(await evaluate(renderer, 'document.title')).includes('long')) break
      await sleep(250)
    }
    // 文档要先渲染出来：等编辑器里出现正文行
    for (let i = 0; i < 80; i++) {
      const lines = await evaluate(renderer, `document.querySelectorAll('#editor .cm-line').length`)
      if (Number(lines) > 5) break
      await sleep(250)
    }

    await evaluate(main, `(() => {
      const { BrowserWindow } = require('electron')
      BrowserWindow.getAllWindows()[0].webContents.send('menu-export-pdf')
      return true
    })()`)

    for (let i = 0; i < 480; i++) {
      if (existsSync(out)) break
      const failure = await evaluate(main, 'globalThis.__exportError && JSON.stringify(globalThis.__exportError)')
      if (failure) throw new Error(`导出报错 ${failure}`)
      await sleep(250)
    }
    if (!existsSync(out)) throw new Error('120s 内没有产出文件')

    renderer.close()
    main.close()

    const { pages, declared, bytes } = pageCount(out)
    const count = Math.max(pages, declared)
    console.log(`PDF ${bytes} 字节，页数 ${count}（/Type /Page ${pages}，/Count ${declared}）`)
    if (count < MIN_PAGES) {
      console.log(`✗ 只导出 ${count} 页，${ROWS} 行的文档不可能只有这么点：整篇没有渲染出来`)
      process.exitCode = 1
      return
    }
    console.log(`✓ ${ROWS} 行的文档导出成 ${count} 页，整篇都在纸上`)
  } finally {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已经退出 */ }
    await sleep(300)
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exitCode = 1
})
