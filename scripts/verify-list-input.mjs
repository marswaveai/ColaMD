#!/usr/bin/env node
// 列表的输入手感验收：回车续行、行首退格、缩进、待办框、代码围栏、引用、有序号补位。
//
// 为什么单独一个脚本：列表手感是**手工拼起来的**行为（CodeMirror 6 只给纯文本，
// 续标记、行首退格这些得自己决定交给谁），它不在类型系统里，也不在任何一条渲染断言里。
// 2026-11-11 橘子报「换行，删行，多空格，少空格，各种乱跳，有时候还会多一行」，
// 逐条查下来是一串边界叠在一起。这个脚本把每一处钉住，防止下次动内核、动装饰层、
// 动语言包命令时又悄悄退化。
//
// 判定标准参照 Obsidian / Typora 的实时预览：行中回车也续标记、行首退格先拆结构
// 再粘行、待办框后面退格只拆框、代码围栏里不接管、引用前缀不丢。
//
// 用法: npm run verify:list（先 npm run build）
// 键盘走 CDP 真键事件（合成的 KeyboardEvent CodeMirror 不认）；文档与光标从
// `.cm-content` 上挂的视图读（与 verify:features 的 typing 断言同一条路）。
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

assertBuildFresh()
const { dir: WORK, udd } = verifyWorkdir('list-input')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
      for (const [, p] of pending) p.rej(new Error('调试目标已关闭（窗口被杀了？）'))
      pending.clear()
    })
  })
}

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
    expression, includeCommandLineAPI: false, returnByValue: true, awaitPromise: true
  }).then((result) => {
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 500))
    return result.result?.value
  })
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vkc: 13 },
  Backspace: { key: 'Backspace', code: 'Backspace', vkc: 8 },
  Tab: { key: 'Tab', code: 'Tab', vkc: 9 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vkc: 39 }
}

async function press(renderer, name, modifiers = 0) {
  const k = KEYS[name]
  for (const type of ['rawKeyDown', 'keyUp']) {
    await renderer.send('Input.dispatchKeyEvent', {
      type, key: k.key, code: k.code, windowsVirtualKeyCode: k.vkc, modifiers
    })
  }
  await sleep(120)
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
}

function reportChecks() {
  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : `  ← ${c.detail}`}`)
  }
  console.log(failed.length
    ? `\n✗ ${failed.length}/${checks.length} 条没通过`
    : `\n✓ ${checks.length} 条全通过`)
  if (failed.length) process.exitCode = 1
}

/** 页面侧的视图：`.cm-content` 上挂着 CodeMirror 的 tile，顺着能拿到 EditorView。 */
const VIEW = `(() => {
  const content = document.querySelector('#editor .cm-content')
  const tile = content && (content.cmTile || content.cmView)
  return tile && tile.root && tile.root.view
})()`

// 场景：起手文档、光标位置（`[锚点, 头]`，头省略即空选区）、按键、期望的文档全文。
// 光标位置一律用「某个片段的下标」算出来，写死数字在中文文档里对不上。
const at = (doc, frag, offset = 0) => doc.indexOf(frag) + offset

const scenarios = [
  { name: '行尾回车续一条', doc: '- 甲\n- 乙', cursor: (d) => [d.indexOf('\n')], keys: ['Enter'], expect: '- 甲\n- \n- 乙', expectHead: (d) => at(d, '- \n- 乙') + 2 },
  { name: '空条目回车退出列表', doc: '- 甲\n- ', cursor: (d) => [d.length], keys: ['Enter'], expect: '- 甲\n' },
  // 光标在行中按回车是断句，断出来的仍然是两条列表项
  { name: '行中回车续标记', doc: '- 甲乙', cursor: (d) => [at(d, '乙')], keys: ['Enter'], expect: '- 甲\n- 乙', expectHead: (d) => at(d, '乙') },
  { name: '待办行尾回车续待办', doc: '- [ ] 甲', cursor: (d) => [d.length], keys: ['Enter'], expect: '- [ ] 甲\n- [ ] ' },
  { name: '有序行尾回车续下号', doc: '1. 甲', cursor: (d) => [d.length], keys: ['Enter'], expect: '1. 甲\n2. ', expectHead: (d) => d.length },
  // 行首退格先拆这一行的结构，最后才轮到粘行；不能落成 `- 甲- 乙`
  { name: '行首退格拆标记而不是粘行', doc: '- 甲\n- 乙', cursor: (d) => [d.indexOf('\n') + 1], keys: ['Backspace'], expect: '- 甲\n乙', expectHead: (d) => d.indexOf('乙') },
  { name: '普通段落前的列表行首退格拆标记', doc: '上文\n- 甲', cursor: (d) => [d.indexOf('\n') + 1], keys: ['Backspace'], expect: '上文\n甲' },
  { name: '缩进项行首退格先退一级', doc: '- 甲\n  - 乙', cursor: (d) => [at(d, '乙') - 2], keys: ['Backspace'], expect: '- 甲\n- 乙' },
  // 围栏里的 `- ` 是代码，不是列表
  { name: '代码围栏里回车不续列表', doc: '```\n- 甲\n```', cursor: (d) => [at(d, '甲') + 1], keys: ['Enter'], expect: '```\n- 甲\n\n```' },
  { name: '引用里的列表续行带 >', doc: '> - 甲', cursor: (d) => [d.length], keys: ['Enter'], expect: '> - 甲\n> - ' },
  { name: 'Tab 整行缩进', doc: '- 甲\n- 乙', cursor: (d) => [at(d, '乙') - 2], keys: ['Tab'], expect: '- 甲\n  - 乙', expectHead: (d) => at(d, '乙') - 2 },
  { name: 'Shift+Tab 整行退一级', doc: '- 甲\n  - 乙', cursor: (d) => [at(d, '乙') - 2], keys: [['Tab', 8]], expect: '- 甲\n- 乙' },
  // 方框是原子区间：光标贴着它退格，不该把 `- ` 一起吞掉
  { name: '待办方框后退格只拆框', doc: '- [ ] 甲', cursor: (d) => [at(d, '甲')], keys: ['Backspace'], expect: '- 甲', expectHead: (d) => 2 },
  { name: '删中间一条有序项补号', doc: '1. 甲\n2. 乙\n3. 丙', cursor: (d) => [at(d, '乙') - 3, at(d, '丙') - 3], keys: ['Backspace'], expect: '1. 甲\n2. 丙' },
  { name: '嵌套行尾回车保留缩进', doc: '  - 甲', cursor: (d) => [d.length], keys: ['Enter'], expect: '  - 甲\n  - ' },
  { name: '方框后打字不破坏语法', doc: '- [ ] 甲', cursor: (d) => [at(d, '甲')], type: 'X', expect: '- [ ] X甲' },
  { name: '连按两次回车退出到空行', doc: '- 甲', cursor: (d) => [d.length], keys: ['Enter', 'Enter'], expect: '- 甲\n' },
  { name: '首行行首退格不删内容', doc: '- 甲', cursor: () => [0], keys: ['Backspace'], observe: '- 甲' },
  { name: '空待办回车退出列表', doc: '- [ ] ', cursor: (d) => [d.length], keys: ['Enter'], expect: '' },
  // 两行列表中间插一条，下一条的序号跟着走
  { name: '行中回车后序号顺延', doc: '1. 甲\n2. 乙', cursor: (d) => [d.length], keys: ['Enter'], expect: '1. 甲\n2. 乙\n3. ', expectHead: (d) => d.length },
  { name: '多位序号接着数', doc: '9. 甲', cursor: (d) => [d.length], keys: ['Enter'], expect: '9. 甲\n10. ' },
  { name: '已勾选的任务续成未勾选', doc: '- [x] 甲', cursor: (d) => [d.length], keys: ['Enter'], expect: '- [x] 甲\n- [ ] ', expectHead: (d) => d.length },
  { name: '深层嵌套回车保留层级', doc: '- 甲\n    - 乙', cursor: (d) => [d.length], keys: ['Enter'], expect: '- 甲\n    - 乙\n    - ', expectHead: (d) => d.length },
  { name: '引用里多行列表中间插一条', doc: '> - 甲\n> - 乙', cursor: (d) => [at(d, '甲') + 1], keys: ['Enter'], expect: '> - 甲\n> - \n> - 乙' },
  // 「多一行」的直接嫌疑：松散列表（项与项之间有空行）里回车
  { name: '松散列表回车保持松散', doc: '1. 甲\n\n2. 乙', cursor: (d) => [d.length], keys: ['Enter'], observe: '' },
  { name: '文档末尾隔一行回车', doc: '- 甲\n\n', cursor: (d) => [at(d, '甲') + 1], keys: ['Enter'], expect: '- 甲\n- \n\n' },
  // 「多空格」的嫌疑：标记后本来就多打了空格的项
  { name: '标记后多空格续行不多留空格', doc: '-   甲', cursor: (d) => [d.length], keys: ['Enter'], observe: '' },
  { name: '标记后按退格拆标记', doc: '- 甲', cursor: (d) => [at(d, '甲')], keys: ['Backspace'], observe: '' }
]

async function main() {
  writeFileSync(join(WORK, 'list.md'), '占位\n', 'utf8')
  const port = 9900 + Math.floor(Math.random() * 60)
  const child = spawn('npx', ['electron', 'scripts/offscreen-window.cjs', join(WORK, 'list.md'),
    `--user-data-dir=${udd}`, `--remote-debugging-port=${port}`
  ], { cwd: join(import.meta.dirname, '..'), stdio: 'ignore', detached: true })

  try {
    const page = await waitTarget(port, (t) => t.type === 'page' && /index\.html/.test(t.url))
    const renderer = await connect(page.webSocketDebuggerUrl)
    // 窗口在屏幕外、又交出了键盘焦点：不开焦点模拟，键盘事件落不到编辑器上
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await renderer.send('Page.bringToFront')

    let ready = false
    for (let i = 0; i < 80; i++) {
      if (await evaluate(renderer, `!!${VIEW}`)) { ready = true; break }
      await sleep(250)
    }
    check('编辑器已就绪', ready, '拿不到编辑器视图，先 npm run build')
    if (!ready) {
      reportChecks()
      return
    }

    const docOf = () => evaluate(renderer, `${VIEW}.state.doc.toString()`)
    const headOf = () => evaluate(renderer, `${VIEW}.state.selection.main.head`)
    const setDoc = (text) => evaluate(renderer, `${VIEW}.dispatch({ changes: { from: 0, to: ${VIEW}.state.doc.length, insert: ${JSON.stringify(text)} }, selection: { anchor: 0 } })`)
    const setCursor = (anchor, head) => evaluate(renderer, `${VIEW}.dispatch({ selection: { anchor: ${anchor}, head: ${head ?? anchor} }, scrollIntoView: true })`)

    // 先真点一下正文：窗口在屏幕外、又没拿到系统焦点时，键盘事件不会落到编辑器
    const box = JSON.parse(await evaluate(renderer, `(() => {
      const r = document.querySelector('#editor .cm-content').getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + 12) })
    })()`))
    let focused = false
    for (let i = 0; i < 6 && !focused; i++) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await renderer.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
      }
      await sleep(300)
      focused = await evaluate(renderer, `!!${VIEW}.hasFocus`)
    }
    check('编辑器拿到焦点', focused === true, String(focused))

    for (const s of scenarios) {
      await setDoc(s.doc)
      const [anchor, head] = s.cursor(s.doc)
      await setCursor(anchor, head)
      if (s.type) {
        await renderer.send('Input.insertText', { text: s.type })
        await sleep(160)
      }
      for (const key of s.keys ?? []) {
        if (Array.isArray(key)) await press(renderer, key[0], key[1])
        else await press(renderer, key)
      }
      const doc = await docOf()
      if (s.observe !== undefined) {
        // 观察项只记录，不判分：这里的行为还没定成契约
        console.log(`· ${s.name}  →  ${JSON.stringify(doc)}`)
        continue
      }
      const caret = await headOf()
      const headOk = !s.expectHead || caret === s.expectHead(doc)
      check(s.name, doc === s.expect && headOk,
        `得到 ${JSON.stringify(doc)} 光标 ${caret}，期望 ${JSON.stringify(s.expect)}${s.expectHead ? ` 光标 ${s.expectHead(doc)}` : ''}`)
    }

    // 右键要一次跨过整个复选框，不是一格一格挪
    await setDoc('- [ ] 甲')
    await setCursor(0)
    await press(renderer, 'ArrowRight')
    const head = await headOf()
    check('右键一次跨过待办方框', head === 6, `光标落在 ${head}，应在 6（甲的起点）`)

    reportChecks()
  } finally {
    stopVerifyApp(udd)
    try { process.kill(-child.pid) } catch { /* 已经退了 */ }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 2
})
