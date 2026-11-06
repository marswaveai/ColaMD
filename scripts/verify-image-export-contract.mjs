#!/usr/bin/env node
// 执行真实的测量和导出控制流；假相机注入设备像素尺寸不足，不代替 Electron 验收。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
import { check, fixtureRows } from './verify-image-export.mjs'

const require = createRequire(import.meta.url)
const baseline = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11)
const source = baseline
  ? execFileSync('git', ['show', `${baseline}:src/main/image-export.ts`], { cwd: new URL('..', import.meta.url), encoding: 'utf8' })
  : readFileSync(new URL('../src/main/image-export.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

async function render({ contentEnd, padding = 64, preset = 'desktop', badPage, badWhole = 'height', dpr = 1, shortage = 2, layoutFailure = false, missingContent = false }) {
  const captures = []
  let destroyed = false
  let dprReads = 0
  const width = preset === 'desktop' ? 1200 : 414
  const pageHeight = preset === 'desktop' ? 800 : 896
  const height = contentEnd + padding
  let offset = 0
  // 非零原点，避免把文档坐标错当成相对编辑器的高度。
  const editorTop = 37.5
  const editor = {
    scrollHeight: height,
    getBoundingClientRect: () => ({ top: editorTop, width }),
    querySelector: () => missingContent ? null : { getBoundingClientRect: () => ({ bottom: contentEnd + editorTop }) }
  }
  class Camera {
    constructor() {
      this.webContents = {
        executeJavaScript: async (expression) => {
          if (expression === 'window.devicePixelRatio') { dprReads++; return dpr }
          if (layoutFailure && expression.includes('document.fonts.ready')) throw new Error('模拟布局等待失败')
          if (expression.includes('contentBounds')) {
            // 不能直接返回预制 dimensions：否则测量分支即使写错，契约仍会假绿。
            return vm.runInNewContext(expression, {
              document: { getElementById: () => editor, documentElement: { scrollWidth: width, scrollHeight: height }, fonts: { ready: Promise.resolve() }, images: [] },
              getComputedStyle: () => ({ paddingBottom: String(padding) }),
              requestAnimationFrame: callback => callback()
            })
          }
          const translated = expression.match(/translateY\((-?[\d.]+)px\)/)
          if (translated) offset = -Number(translated[1]) || 0
        },
        beginFrameSubscription() {}, endFrameSubscription() {},
        capturePage: async (rect) => {
          const whole = captures.length === 0 && height * dpr <= 16384
          captures.push({ ...rect, offset, whole })
          // Electron 44 capturePage 的 NativeImage.getSize() 是设备像素，不是 DIP。
          const size = { width: Math.ceil(rect.width * dpr), height: Math.ceil(rect.height * dpr) }
          if (whole && badWhole) size[badWhole] -= shortage
          else if (!whole && badPage) size[badPage] -= shortage
          return { getSize: () => size, toPNG: () => Buffer.from('test-png') }
        }
      }
    }
    async loadFile() {}
    setContentSize() {}
    isDestroyed() { return destroyed }
    destroy() { destroyed = true }
  }
  const exports = {}
  vm.runInNewContext(code, {
    exports, require: name => name === 'electron' ? { BrowserWindow: Camera } : require(name),
    setTimeout, clearTimeout, Buffer, console: { ...console, error() {} }
  })
  try {
    const pages = await exports.renderDocumentImages({ html: '', styles: '', bodyClass: '', background: '#fff' }, preset)
    assert.equal(dprReads, 1, 'DPR 只测一次，不应每页跨进程查询')
    return { pages, captures, destroyed, pageHeight }
  } catch (error) {
    assert.equal(destroyed, true, '异常后也必须销毁相机')
    throw error
  }
}

let count = 0
// 实测 padding、非整数正文边界及回退测量均必须保持末尾、不多留白页。
for (const preset of ['desktop', 'mobile']) {
  const pageHeight = preset === 'desktop' ? 800 : 896
  for (const padding of [0, preset === 'desktop' ? 64 : 28, 200]) {
    for (const delta of [-32, -0.5, 0, 0.5, 32]) {
      for (const layoutFailure of [false, true]) {
        const contentEnd = 2 * pageHeight + delta
        const result = await render({ preset, padding, contentEnd, layoutFailure })
        const pages = result.captures.filter(capture => !capture.whole)
        assert.equal(pages.length, delta > 0 ? 3 : 2, `${preset} padding=${padding} delta=${delta} fallback=${layoutFailure}`)
        assert.equal(result.pages.length, pages.length)
        assert.equal(result.destroyed, true)
        for (const [index, page] of pages.entries()) {
          assert.equal(page.offset, index * pageHeight)
          assert(page.offset < contentEnd, '不能生成只有 padding 的页')
          assert.equal(page.height, Math.min(pageHeight, Math.ceil(contentEnd + padding) - page.offset))
        }
        assert(pages.at(-1).offset + pages.at(-1).height >= contentEnd, '不能裁掉正文末尾')
        count++
      }
    }
  }
}
for (const layoutFailure of [false, true]) {
  const result = await render({ contentEnd: 1600, padding: 200, missingContent: true, layoutFailure })
  assert.equal(result.pages.length, 2, '无 contentBounds 时应从 scrollHeight 扣实测 padding')
  count++
}
for (const dpr of [1, 1.1, 1.25, 1.5, 1.75, 2, 3]) {
  for (const dimension of ['width', 'height']) {
    await assert.rejects(render({ contentEnd: 1700, badPage: dimension, dpr }), /分页截图尺寸不足/)
    const fallback = await render({ contentEnd: 1700, badWhole: dimension, dpr })
    assert.equal(fallback.pages.length, 3, '整图尺寸不足必须回退分页')
    count += 2
  }
  const whole = await render({ contentEnd: 1700, badWhole: null, dpr })
  assert.equal(whole.pages.length, 1)
  const rounded = await render({ contentEnd: 1700, shortage: 1, dpr })
  assert.equal(rounded.pages.length, 1, '最多容许浮点 DPR 的 1 设备像素取整差')
  const result = await render({ contentEnd: Math.ceil(16384 / dpr) + 1, dpr })
  assert(result.captures.every(capture => !capture.whole), '超过设备像素上限应直接分页')
  for (const preset of ['desktop', 'mobile']) {
    assert(fixtureRows({ expect: 'pages', preset }, dpr) * 40 * dpr > 16384)
    assert((fixtureRows({ expect: 'single', preset }, dpr) * 80 + 1024) * dpr < 16384)
    count += 2
  }
  count += 3
}
// DPR=2 的半幅截图仍大于 CSS 尺寸，旧的单位比较会错误放行。
for (const dimension of ['width', 'height']) {
  const fallback = await render({ contentEnd: 1700, badWhole: dimension, dpr: 2, shortage: dimension === 'width' ? 1200 : 1764 })
  assert.equal(fallback.pages.length, 3)
  await assert.rejects(render({ contentEnd: 1700, badPage: dimension, dpr: 2, shortage: dimension === 'width' ? 1200 : 800 }), /分页截图尺寸不足/)
  count += 2
}
// 原 oracle 的两个真实漏网反例：末行 40px 仅剩 1px、第二页 3/5/6 丢整行 4。
for (const dpr of [1, 1.25, 2, 3]) {
  const height = 40 * dpr
  const testCase = { rows: 7, width: 1200, expect: 'pages' }
  const sample = sequences => ({
    dpr, pages: ['first.png', 'last.png'],
    analysed: sequences.map(sequence => ({ size: { width: 1200 * dpr, height: sequence.length }, sequence }))
  })
  const band = row => Array(height).fill(row)
  const first = [0, 1, 2].flatMap(band)
  const last = [3, 4, 5, 6].flatMap(band)
  assert.equal(check(testCase, sample([first, last])).problems.length, 0)
  const clipped = check(testCase, sample([first, [...[3, 4, 5].flatMap(band), 6]]))
  assert(clipped.problems.some(problem => problem.includes('行 6 累计 1 ')))
  const missing = check(testCase, sample([first, [3, 5, 6].flatMap(band)]))
  assert(missing.problems.some(problem => problem.includes('行 4 累计 0 ')))
  assert(missing.problems.some(problem => problem.includes('色带缺失')))
  assert(check(testCase, sample([first, []])).problems.some(problem => problem.includes('没有正文')))
  // 同一行横跨两页时要累计，而不能误判成重复行或放过残片。
  const split = sample([[...first, ...band(3).slice(0, height / 2)], [...band(3).slice(height / 2), ...[4, 5, 6].flatMap(band)]])
  assert.equal(check(testCase, split).problems.length, 0)
  count += 5
}
console.log(`通过 ${count} 项导出测量、设备像素尺寸及 oracle 契约（含两类漏网反例；假相机不代表 Electron 验收）`)
