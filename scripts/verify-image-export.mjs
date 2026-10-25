#!/usr/bin/env node
// 图片导出的真机验证：驱动真实的导出通道，再按颜色条带检查每一行是否都在、有没有重复。
//
// 为什么要颜色条带：分页和拼接出过「接缝处丢掉一小条内容」的 bug（#121 丢了 28px），
// 肉眼很难发现。这里让每一行的底色按行号编码成一个唯一颜色，导出后用像素取色还原行号，
// 于是「有没有丢行、重复行、被压扁的行」都变成严格的数值比较，不需要 OCR。
//
// 用法: npm run verify:image-export（先 npm run build）
// 窗口一律放在屏幕外，测试不占用屏幕。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

const APP = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
let WORK
let EVIDENCE

// 短的应导出成一张连续长图，长的应退回编号页；两个阅读宽度走的是同一套逻辑
const CASES = [
  { name: 'short', preset: 'desktop', width: 1200, expect: 'single' },
  { name: 'long', preset: 'desktop', width: 1200, expect: 'pages' },
  { name: 'mobile-short', preset: 'mobile', width: 414, expect: 'single' },
  { name: 'mobile-long', preset: 'mobile', width: 414, expect: 'pages' },
  ...['desktop', 'mobile'].flatMap(preset => [0, 200].map(padding => ({
    name: `${preset}-padding-${padding}`, preset, width: preset === 'desktop' ? 1200 : 414,
    padding, expect: 'pages'
  })))
]

// 行号编码成颜色：base 16 的三个通道，相邻行至少差 12，取色不会有歧义
function colorOf(index) {
  const level = (value) => 32 + value * 12
  return [
    level(index % 16),
    level(Math.floor(index / 16) % 16),
    level(Math.floor(index / 256) % 16)
  ]
}

function bandsHTML(rows) {
  const blocks = []
  for (let i = 0; i < rows; i++) {
    const [r, g, b] = colorOf(i)
    blocks.push(`<div style="height:40px;background:rgb(${r},${g},${b})">&nbsp;</div>`)
  }
  return blocks.join('\n')
}

function document(rows) {
  return `# 导出验证\n\n${bandsHTML(rows)}\n`
}

// 每个用例用自己的真实 DPR 选长度，不能依赖上一扇窗口的屏幕比例。
export function fixtureRows(testCase, dpr) {
  if (testCase.expect === 'pages') return Math.ceil(16384 / dpr / 40) + 2
  // 给标题、外边距及块间距留足预算，最终仍由真实导出形态验证。
  return Math.max(1, Math.min(testCase.preset === 'desktop' ? 60 : 30, Math.floor((16384 / dpr - 1024) / 80)))
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
  return client.send('Runtime.evaluate', { expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true })
    .then((result) => {
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400))
      return result.result?.value
    })
}

// 在应用主进程里读 PNG：逐行取众数颜色（背景占多数，所以文字不会干扰），再还原成行号
function analyseCode(paths, rows) {
  const palette = []
  for (let i = 0; i < rows; i++) palette.push(colorOf(i))
  return `(() => {
    const { nativeImage } = require('electron')
    const palette = ${JSON.stringify(palette)}
    const read = (path) => {
      const image = nativeImage.createFromPath(path)
      const { width, height } = image.getSize()
      const bitmap = image.toBitmap() // BGRA
      const sequence = []
      for (let y = 0; y < height; y++) {
        const tally = new Map()
        for (let x = 8; x < width - 8; x += 8) {
          const offset = (y * width + x) * 4
          const key = bitmap[offset + 2] + ',' + bitmap[offset + 1] + ',' + bitmap[offset]
          tally.set(key, (tally.get(key) ?? 0) + 1)
        }
        let best = null
        for (const [key, hits] of tally) if (!best || hits > best.hits) best = { key, hits }
        const [r, g, b] = best.key.split(',').map(Number)
        let match = -1
        for (let i = 0; i < palette.length; i++) {
          const [pr, pg, pb] = palette[i]
          if (Math.abs(pr - r) <= 4 && Math.abs(pg - g) <= 4 && Math.abs(pb - b) <= 4) { match = i; break }
        }
        sequence.push(match)
      }
      return { size: image.getSize(), sequence }
    }
    return ${JSON.stringify(paths)}.map(read)
  })()`
}

async function runCase(testCase) {
  const port = 9500 + Math.floor(Math.random() * 400)
  const inspect = port + 1000
  const dir = join(EVIDENCE, testCase.name)
  mkdirSync(dir, { recursive: true })
  const fixture = join(dir, `${testCase.name}.md`)
  const out = join(dir, `${testCase.name}.png`)
  writeFileSync(fixture, document(1), 'utf8')

  const log = openSync(join(dir, 'electron.log'), 'a')
  const child = spawn('npx', ['electron', 'scripts/offscreen-window.cjs', fixture, `--user-data-dir=${join(WORK, testCase.name, 'udd')}`,
    // sRGB：macOS 的显示色彩管理会把取色值整体挪动，验证要在确定的色彩空间里做
    '--force-color-profile=srgb',
    ...(process.env.COLAMD_VERIFY_DPR ? [`--force-device-scale-factor=${process.env.COLAMD_VERIFY_DPR}`] : []),
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
      const { BrowserWindow, dialog, shell } = require('electron')
      globalThis.__exportDone = false
      shell.showItemInFolder = () => { globalThis.__exportDone = true }
      BrowserWindow.prototype.show = function () {}
      BrowserWindow.prototype.focus = function () {}
      BrowserWindow.getAllWindows().forEach((win) => { win.setPosition(-4000, -4000) })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(out)} })
      globalThis.__exportError = null
      dialog.showMessageBox = async (win, options) => { globalThis.__exportError = options; return { response: 0 } }
      return true
    })()`)

    for (let i = 0; i < 80; i++) {
      const title = String(await evaluate(renderer, 'document.title'))
      if (title.includes(testCase.name)) break
      await sleep(250)
    }

    const dpr = await evaluate(renderer, 'window.devicePixelRatio')
    if (!(dpr > 0)) throw new Error(`无效 DPR ${dpr}`)
    testCase.rows = fixtureRows(testCase, dpr)
    const markdown = document(testCase.rows)
    writeFileSync(fixture, markdown, 'utf8')
    await evaluate(main, `(() => {
      const wc = require('electron').BrowserWindow.getAllWindows()[0].webContents
      wc.send('file-opened', { path: ${JSON.stringify(fixture)}, content: ${JSON.stringify(markdown)} })
      return true
    })()`)
    await evaluate(renderer, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (testCase.expect === 'pages' && testCase.rows * 40 * dpr <= 16384) {
      throw new Error(`夹具未跨过真实捕获上限：${testCase.rows} 行，DPR ${dpr}`)
    }
    if (testCase.padding !== undefined) {
      // 走应用真正的自定义主题入口，CSS 原样进入导出快照；只将正文换成精确的边界夹具。
      await evaluate(main, `require('electron').BrowserWindow.getAllWindows()[0].webContents.send('set-custom-css', ${JSON.stringify(`body.theme-custom #editor { padding-bottom: ${testCase.padding}px !important; }`)})`)
      const pageHeight = testCase.preset === 'desktop' ? 800 : 896
      const paddingTop = testCase.preset === 'desktop' ? 64 : 28
      // 0 padding 的尾行跨页且不足预设 padding；200 padding 的正文距边界 32px，留白不能另起一页。
      const remainder = testCase.padding === 0 ? Math.min(32, paddingTop / 2) : pageHeight - 32
      const spacer = ((remainder - paddingTop - testCase.rows * 40) % pageHeight + pageHeight) % pageHeight
      const html = `<div style="height:${spacer}px"></div>${bandsHTML(testCase.rows)}`
      await evaluate(renderer, `(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        if (!document.body.classList.contains('theme-custom')) throw new Error('自定义主题未应用')
        window.electronAPI.exportImage({
          html: ${JSON.stringify(html)},
          styles: Array.from(document.styleSheets).map(sheet => Array.from(sheet.cssRules).map(rule => rule.cssText).join('\\n')).join('\\n'),
          bodyClass: document.body.className, background: '#ffffff'
        }, ${JSON.stringify(testCase.preset)}).then(ok => { window.__imageResult = ok })
      })()`)
    } else {
      await evaluate(main, `(() => {
        require('electron').BrowserWindow.getAllWindows()[0].webContents.send('menu-export-image', ${JSON.stringify(testCase.preset)})
        return true
      })()`)
    }

    for (let i = 0; i < 480; i++) {
      if (await evaluate(main, 'globalThis.__exportDone')) break
      const failure = await evaluate(main, 'globalThis.__exportError && JSON.stringify(globalThis.__exportError)')
      if (failure) throw new Error(`导出报错 ${failure}`)
      await sleep(250)
    }
    if (!await evaluate(main, 'globalThis.__exportDone') || !existsSync(out)) throw new Error('120s 内没有完成全部图片写入')

    const base = `${testCase.name}.png`
    const pages = readdirSync(dir)
      .filter((file) => file.endsWith('.png') && (file === base || file.startsWith(`${testCase.name}-`)))
      .sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)))
      .map((file) => join(dir, file))

    const analysed = await evaluate(main, analyseCode(pages, testCase.rows))
    renderer.close()
    main.close()
    return { pages, analysed, dpr }
  } finally {
    stopVerifyApp(WORK)
    await sleep(300)
  }
}

function runs(sequence) {
  const out = []
  for (const index of sequence) {
    const last = out[out.length - 1]
    if (last && last.index === index) last.length++
    else out.push({ index, length: 1 })
  }
  return out.filter((run) => run.index >= 0)
}

export function check(testCase, { pages, analysed, dpr }) {
  const problems = []
  const shape = pages.length === 1 ? 'single' : 'pages'
  if (shape !== testCase.expect) problems.push(`导出形态是 ${shape}，期望 ${testCase.expect}`)
  const totals = Array(testCase.rows).fill(0)
  const order = []
  for (const [pageIndex, page] of analysed.entries()) {
    if (Math.abs(page.size.width - testCase.width * dpr) > 1 || page.size.height <= 0) {
      problems.push(`第 ${pageIndex + 1} 页尺寸异常：${JSON.stringify(page.size)}，DPR ${dpr}`)
    }
    const bands = runs(page.sequence)
    if (!bands.length) problems.push(`第 ${pageIndex + 1} 页没有正文色带`)
    for (const band of bands) {
      totals[band.index] += band.length
      if (order.at(-1) !== band.index) order.push(band.index)
    }
  }
  if (order.length !== testCase.rows || order.some((row, index) => row !== index)) {
    problems.push(`色带缺失、重复或顺序错误：${JSON.stringify(order)}`)
  }
  // CSS 边界到设备像素网格取整，两个端点的差最多 1 设备像素。
  // 跨页仍累计整行，首尾与仅剩 1px 的残行都不再豁免。
  for (const [row, total] of totals.entries()) {
    if (Math.abs(total - 40 * dpr) > 1) problems.push(`行 ${row} 累计 ${total} 设备像素，应为 ${40 * dpr}±1`)
  }
  const sizes = analysed.map((page) => `${page.size.width}x${page.size.height}`)
  return { problems, sizes, pageCount: pages.length, totals }
}

async function main() {
  assertBuildFresh()
  WORK = verifyWorkdir('image-export').dir
  // profile 可清理，原始图片和失败分析不得随退出消失。
  EVIDENCE = mkdtempSync(join(tmpdir(), 'colamd-image-export-evidence-'))
  console.log(`证据目录 ${EVIDENCE}`)
  let failed = 0
  for (const testCase of CASES.filter(testCase => !process.env.COLAMD_VERIFY_CASE || testCase.name.includes(process.env.COLAMD_VERIFY_CASE))) {
    try {
      const result = await runCase(testCase)
      const checked = check(testCase, result)
      writeFileSync(join(EVIDENCE, `${testCase.name}-analysis.json`), JSON.stringify({ testCase, ...result, ...checked }, null, 2))
      const { problems, sizes, pageCount } = checked
      const shape = pageCount === 1 ? '一张连续长图' : `${pageCount} 张编号页`
      if (problems.length) {
        failed++
        console.log(`✗ ${testCase.name} ${shape} ${sizes.join(' ')}`)
        for (const problem of problems) console.log(`    ${problem}`)
      } else {
        console.log(`✓ ${testCase.name} ${shape} ${sizes.join(' ')}：${testCase.rows} 行全部到位、无重复、无压扁，DPR ${result.dpr}`)
      }
    } catch (error) {
      failed++
      writeFileSync(join(EVIDENCE, `${testCase.name}-error.txt`), error.stack ?? String(error))
      console.log(`✗ ${testCase.name} ${error.message}`)
    }
  }
  console.log(failed ? `失败 ${failed} 项` : '全部通过')
  process.exitCode = failed ? 1 : 0
}

// 可从 Node 契约探针导入像素 oracle，不启动应用、不清理其他测试 profile。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
