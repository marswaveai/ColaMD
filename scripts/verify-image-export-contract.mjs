#!/usr/bin/env node
// Node 契约探针：执行真实导出控制流，用假相机注入尺寸不足；不启动 Electron。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
import { check } from './verify-image-export.mjs'

const require = createRequire(import.meta.url)
// 可指定旧提交做红基线，不能依赖开发者当前暂存区里的偶然内容。
const baseline = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11)
const source = baseline
  ? execFileSync('git', ['show', `${baseline}:src/main/image-export.ts`], { cwd: new URL('..', import.meta.url), encoding: 'utf8' })
  : readFileSync(new URL('../src/main/image-export.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

async function render({ contentEnd, padding = 64, preset = 'desktop', badPage, badWhole = 'height', dpr = 1 }) {
  const captures = []
  let destroyed = false
  const width = preset === 'desktop' ? 1200 : 414
  const pageHeight = preset === 'desktop' ? 800 : 896
  const height = contentEnd + padding
  let offset = 0
  class Camera {
    constructor() {
      this.webContents = {
        executeJavaScript: async (expression) => {
          if (expression === 'window.devicePixelRatio') return dpr
          if (expression.includes('contentBounds')) return { width, height }
          const translated = expression.match(/translateY\((-?[\d.]+)px\)/)
          if (translated) offset = -Number(translated[1]) || 0
        },
        beginFrameSubscription() {}, endFrameSubscription() {},
        capturePage: async (rect) => {
          const whole = captures.length === 0 && height * dpr <= 16384
          captures.push({ ...rect, offset, whole })
          const size = { width: rect.width, height: rect.height }
          if (whole) size[badWhole]--
          else if (badPage) size[badPage]--
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
    exports, require: (name) => name === 'electron' ? { BrowserWindow: Camera } : require(name),
    setTimeout, clearTimeout, Buffer, console
  })
  try {
    const pages = await exports.renderDocumentImages({ html: '', styles: '', bodyClass: '', background: '#fff' }, preset)
    return { pages, captures, destroyed, pageHeight }
  } catch (error) {
    assert.equal(destroyed, true, '异常后也必须销毁相机')
    throw error
  }
}

let count = 0
for (const preset of ['desktop', 'mobile']) {
  const pageHeight = preset === 'desktop' ? 800 : 896
  const padding = preset === 'desktop' ? 64 : 28
  for (const delta of [-1, 0, 1, -Math.floor(padding / 2)]) {
    const contentEnd = 2 * pageHeight + delta
    const result = await render({ preset, padding, contentEnd })
    const pages = result.captures.filter((capture) => !capture.whole)
    assert.equal(pages.length, delta > 0 ? 3 : 2)
    assert.equal(result.pages.length, pages.length)
    assert.equal(result.destroyed, true)
    for (const [index, page] of pages.entries()) {
      assert.equal(page.offset, index * pageHeight)
      assert(page.offset < contentEnd, '不能生成只有 padding 的页')
      assert.equal(page.height, Math.min(pageHeight, contentEnd + padding - page.offset))
    }
    assert(pages.at(-1).offset + pages.at(-1).height >= contentEnd, '不能裁掉正文末尾')
    count++
  }
}
for (const badPage of ['width', 'height']) {
  await assert.rejects(render({ contentEnd: 1700, badPage }), /分页截图尺寸不足/)
  count++
}
const fallback = await render({ contentEnd: 1700, badWhole: 'width' })
assert.equal(fallback.pages.length, 3, '整图宽度不足也必须回退')
count++
for (const dpr of [1, 1.25, 2, 3]) {
  const result = await render({ contentEnd: Math.ceil(16384 / dpr) + 1, dpr })
  assert(result.captures.every((capture) => !capture.whole), '超过设备像素上限应直接分页')
  count++
}
// 独立合成像素序列验证 oracle：末行只剩 1px 的旧漏网样本必须失败。
for (const dpr of [1, 1.25, 2, 3]) {
  const height = 40 * dpr
  const first = Array(height).fill(0).concat(Array(height / 2).fill(1))
  const last = Array(height / 2).fill(1)
  const testCase = { rows: 2, width: 1200, expect: 'pages' }
  const sample = (tail) => ({
    dpr, pages: ['first.png', 'last.png'],
    analysed: [first, tail].map(sequence => ({ size: { width: 1200 * dpr, height: sequence.length }, sequence }))
  })
  assert.equal(check(testCase, sample(last)).problems.length, 0)
  const clipped = sample(last)
  clipped.analysed[0].sequence = Array(height).fill(0)
  clipped.analysed[1].sequence = [1]
  assert(check(testCase, clipped).problems.some(problem => problem.includes('累计')))
  assert(check(testCase, sample([])).problems.some(problem => problem.includes('没有正文')))
  count += 3
}
console.log(`通过 ${count} 项导出控制流及像素 oracle 契约（假相机，不代表 Electron 像素验收）`)
