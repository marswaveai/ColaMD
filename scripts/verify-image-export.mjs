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
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

const APP = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
assertBuildFresh()
const { dir: WORK } = verifyWorkdir('image-export')

// 短的应导出成一张连续长图，长的应退回编号页；两个阅读宽度走的是同一套逻辑
const CASES = [
  { name: 'short', preset: 'desktop', width: 1200, rows: 60, expect: 'single' },
  { name: 'long', preset: 'desktop', width: 1200, rows: 130, expect: 'pages' },
  { name: 'mobile-short', preset: 'mobile', width: 414, rows: 30, expect: 'single' },
  { name: 'mobile-long', preset: 'mobile', width: 414, rows: 130, expect: 'pages' }
]

// 行号编码成颜色：base 7 的三个通道，相邻行至少差 30，取色不会有歧义
function colorOf(index) {
  const level = (value) => 40 + value * 30
  return [
    level(index % 7),
    level(Math.floor(index / 7) % 7),
    level(Math.floor(index / 49) % 7)
  ]
}

function document(rows) {
  const blocks = []
  for (let i = 0; i < rows; i++) {
    const [r, g, b] = colorOf(i)
    blocks.push(`<div style="height:40px;background:rgb(${r},${g},${b})">&nbsp;</div>`)
  }
  return `# 导出验证\n\n${blocks.join('\n\n')}\n`
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
  const dir = join(WORK, testCase.name)
  mkdirSync(dir, { recursive: true })
  const fixture = join(dir, `${testCase.name}.md`)
  const out = join(dir, `${testCase.name}.png`)
  writeFileSync(fixture, document(testCase.rows), 'utf8')

  const child = spawn('npx', ['electron', 'scripts/offscreen-window.cjs', fixture, `--user-data-dir=${join(dir, 'udd')}`,
    // sRGB：macOS 的显示色彩管理会把取色值整体挪动，验证要在确定的色彩空间里做
    '--force-color-profile=srgb',
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

    await evaluate(main, `(() => {
      const { BrowserWindow } = require('electron')
      BrowserWindow.getAllWindows()[0].webContents.send('menu-export-image', ${JSON.stringify(testCase.preset)})
      return true
    })()`)

    for (let i = 0; i < 480; i++) {
      if (existsSync(out)) break
      const failure = await evaluate(main, 'globalThis.__exportError && JSON.stringify(globalThis.__exportError)')
      if (failure) throw new Error(`导出报错 ${failure}`)
      await sleep(250)
    }
    if (!existsSync(out)) throw new Error('120s 内没有产出文件')

    const base = `${testCase.name}.png`
    const pages = readdirSync(dir)
      .filter((file) => file.endsWith('.png') && (file === base || file.startsWith(`${testCase.name}-`)))
      .sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)))
      .map((file) => join(dir, file))

    const analysed = await evaluate(main, analyseCode(pages, testCase.rows))
    renderer.close()
    main.close()
    return { pages, analysed }
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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function check(testCase, { pages, analysed }) {
  const problems = []
  const shape = pages.length === 1 ? 'single' : 'pages'
  if (shape !== testCase.expect) problems.push(`导出形态是 ${shape}，期望 ${testCase.expect}`)

  const perPage = analysed.map((page) => runs(page.sequence))
  const interior = perPage.flatMap((page) => page.slice(1, -1))
  const rowHeight = median(interior.map((run) => run.length))
  const dpr = analysed[0].size.width / testCase.width

  if (pages.length === 1) {
    const all = perPage[0]
    for (let i = 0; i < all.length; i++) {
      if (all[i].index !== i) { problems.push(`第 ${i} 条色带是行 ${all[i].index}，序号对不上`); break }
    }
    if (all.length !== testCase.rows) problems.push(`还原出 ${all.length} 行，应为 ${testCase.rows} 行`)
  } else {
    const head = perPage[0][0]
    if (!head || head.index !== 0) problems.push('第一页不是从第 0 行开始')
    const tail = perPage[perPage.length - 1]
    const lastIndex = tail.length ? tail[tail.length - 1].index : -1
    if (lastIndex !== testCase.rows - 1) problems.push(`最后一页收在第 ${lastIndex} 行，应为第 ${testCase.rows - 1} 行`)
    for (let i = 1; i < perPage.length; i++) {
      const previous = perPage[i - 1]
      const current = perPage[i]
      if (!previous.length || !current.length) { problems.push(`第 ${i + 1} 页没有还原出任何行`); continue }
      const gap = current[0].index - previous[previous.length - 1].index
      // 0 表示这一行正好横跨页边界，1 表示接上了；更大是丢行，更小是重复
      if (gap !== 0 && gap !== 1) {
        problems.push(`第 ${i + 1} 页接缝错位：上一页末行 ${previous[previous.length - 1].index}，本页首行 ${current[0].index}`)
      }
    }
  }

  // 每条色带的高度必须和它的邻居一致：接缝处被压扁或切掉就靠这一条抓出来
  const squashed = []
  for (const page of perPage) {
    for (const run of page.slice(1, -1)) {
      if (Math.abs(run.length - rowHeight) > 4) {
        squashed.push(`行 ${run.index} 高 ${Math.round(run.length * 2 / dpr)} 设备像素，同图其它行是 ${Math.round(rowHeight * 2 / dpr)}`)
      }
    }
  }
  problems.push(...squashed.slice(0, 5))

  const sizes = analysed.map((page) => `${page.size.width}x${page.size.height}`)
  return { problems, sizes, pageCount: pages.length }
}

console.log(`验证目录 ${WORK}`)
let failed = 0
for (const testCase of CASES) {
  try {
    const result = await runCase(testCase)
    const { problems, sizes, pageCount } = check(testCase, result)
    const shape = pageCount === 1 ? '一张连续长图' : `${pageCount} 张编号页`
    if (problems.length) {
      failed++
      console.log(`✗ ${testCase.name} ${shape} ${sizes.join(' ')}`)
      for (const problem of problems) console.log(`    ${problem}`)
    } else {
      console.log(`✓ ${testCase.name} ${shape} ${sizes.join(' ')}：${testCase.rows} 行全部到位、无重复、无压扁`)
    }
  } catch (error) {
    failed++
    console.log(`✗ ${testCase.name} ${error.message}`)
  }
}
console.log(failed ? `失败 ${failed} 项` : '全部通过')
process.exit(failed ? 1 : 0)
