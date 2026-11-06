#!/usr/bin/env node
// Word 导出的验收：把产物解包，量 XML 结构。
//
// 为什么需要它：#202 报的三个毛病（字体写死 Menlo 导致 Windows 上代码块变符号乱码、
// 多行代码没有真换行、代码段落继承两端对齐把键值顶到两边）都是 **Windows 才能看见** 的，
// 在 mac 上导出一次看起来完全正常。所以判据只能落到 document.xml 上：
// 字体槽位里有平台等宽字体和中文回退、每行代码之间有一个 <w:br/>、代码段落显式左对齐。
//
// 用法: npm run verify:docx
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const APP = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const WORK = join(homedir(), 'Library', 'Caches', 'colamd-verify', 'docx')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`✓ ${name}`)
  } else {
    failed += 1
    console.log(`✗ ${name} ${detail}`)
  }
}

// 主进程模块 import 了 electron（nativeImage）。这个脚本在纯 node 里跑，给一个桩：
// 代码块那条路径根本不碰图片，桩只需要存在。
const stub = join(WORK, 'electron-stub.cjs')
writeFileSync(stub, 'module.exports = { nativeImage: { createFromDataURL: () => ({ isEmpty: () => true }), createFromPath: () => ({ isEmpty: () => true }) } }\n')
const bundle = join(WORK, 'docx-export.cjs')
execFileSync('npx', ['esbuild', join(APP, 'src/main/docx-export.ts'), '--bundle', '--platform=node',
  '--format=cjs', `--alias:electron=${stub}`, `--outfile=${bundle}`, '--log-level=error'], { cwd: APP })

const CODE = ['{', '  "key": "值",', '', '  "nested": {', '    "a": 1', '  }', '}'].join('\n')
const fixture = [
  '# 导出验证',
  '',
  '正文里有 `行内代码` 和中文。',
  '',
  '```json',
  CODE,
  '```',
  '',
  '> 引用第一段',
  '>',
  '> 引用第二段',
  '',
].join('\n')

const require_ = createRequire(import.meta.url)
const { markdownToDocx } = require_(bundle)
const docxPath = join(WORK, 'out.docx')
writeFileSync(docxPath, await markdownToDocx({ content: fixture, sourcePath: null }))

let xml = ''
try {
  xml = execFileSync('unzip', ['-p', docxPath, 'word/document.xml']).toString('utf8')
} catch {
  console.log('✗ 解不开 docx（缺 unzip？）')
  process.exitCode = 1
  rmSync(WORK, { recursive: true, force: true })
  process.exit()
}

// 1. 字体：代码不能写死 macOS 字体，四个槽位里要有平台等宽字体 + 中文回退
const fontSlots = [...xml.matchAll(/<w:rFonts ([^/>]*)\/>/g)].map((m) => m[1])
const codeSlots = fontSlots.filter((slot) => /(Menlo|Consolas|DejaVu Sans Mono)/.test(slot))
check('代码字体不是写死的 Menlo', codeSlots.length > 0 && codeSlots.every((slot) => /w:eastAsia="/.test(slot)),
  `代码 run 的字体槽位=${JSON.stringify(codeSlots.slice(0, 2))}`)
check('代码字体按平台选（macOS 是 Menlo）', codeSlots.every((slot) => process.platform !== 'darwin' || /w:ascii="Menlo"/.test(slot)))

// 2. 换行：每行代码之间要有一个 <w:br/>，不能只有一个塞着 \n 的 <w:t>
const breaks = (xml.match(/<w:br\/>/g) ?? []).length
const codeLines = CODE.split('\n').length
const quoteBreaks = 1
check('代码块每行之间是 <w:br/>，不是自动折行', breaks === codeLines - 1 + quoteBreaks,
  `<w:br/> ${breaks} 个，期望 ${codeLines - 1 + quoteBreaks}`)
check('代码里没有塞进 <w:t> 的换行符', !/<w:t[^>]*>[^<]*\n[^<]*<\/w:t>/.test(xml))

// 3. 对齐与拼写检查：代码段落显式左对齐，变量名不带红波浪线
check('代码段落显式左对齐', /w:jc w:val="left"/.test(xml))
check('代码 run 关掉拼写检查', (xml.match(/<w:noProof\/>/g) ?? []).length >= codeLines)
check('代码里的空格保留（xml:space）', /<w:t xml:space="preserve">\s{2}&quot;key&quot;/.test(xml))

// 4. 内容不丢
check('中文注释保留', xml.includes('值'))
check('引用两段都在，且没有挤成一段', xml.includes('引用第一段') && xml.includes('引用第二段'))
check('标题保留', xml.includes('导出验证'))

mkdirSync(WORK, { recursive: true })
rmSync(WORK, { recursive: true, force: true })
console.log(`\n${passed} passed / ${failed} failed`)
if (failed > 0) process.exitCode = 1
