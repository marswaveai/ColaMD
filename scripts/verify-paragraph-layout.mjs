#!/usr/bin/env node
// 真窗口验段落排版、空行与键盘输入。只使用隔离文件，窗口按仓库约定离屏。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertBuildFresh } from './build-freshness.mjs'
import { verifyWorkdir, stopVerifyApp } from './verify-workdir.mjs'

assertBuildFresh()
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const { dir, udd } = verifyWorkdir('paragraph-layout')
const fixture = join(dir, '段落排版.md')
writeFileSync(fixture, '# 段落排版\n\n测试正文。\n')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const port = 9386
const app = spawn(join(ROOT, 'node_modules/.bin/electron'), [
  join(ROOT, 'scripts/offscreen-window.cjs'), fixture, `--user-data-dir=${udd}`,
  `--remote-debugging-port=${port}`,
], { cwd: ROOT, env, stdio: 'ignore' })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let socket
let count = 0
function check(name, actual, expected = true) {
  assert.deepEqual(actual, expected, name)
  console.log('✓ ' + name)
  count++
}
async function connect() {
  let page
  for (let i = 0; i < 120 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page') } catch {}
    if (!page) await sleep(100)
  }
  assert.ok(page, 'Electron 窗口启动')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject) })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('验证窗口已关闭')) }
    pending.clear()
  })
  return (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(method + ' 超时')) }, 15000)
    pending.set(key, { resolve, reject, timer })
    socket.send(JSON.stringify({ id: key, method, params }))
  })
}

try {
  const send = await connect()
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  for (let i = 0; i < 100; i++) {
    if (await evaluate("document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.toString().includes('测试正文。')")) break
    await sleep(100)
  }
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1400, deviceScaleFactor: 1, mobile: false })
  await evaluate("window.v=document.querySelector('.cm-content').cmTile.root.view;void 0")
  check('打开未编辑文件逐字保真', readFileSync(fixture, 'utf8'), '# 段落排版\n\n测试正文。\n')
  const reset = async (doc, head = 0) => {
    await evaluate(`v.setState(v.state.constructor.create({doc:${JSON.stringify(doc)},selection:{anchor:${head}},extensions:v.state.config.base}));v.focus()`)
    await sleep(60)
  }
  const text = () => evaluate('v.state.doc.toString()')
  const head = () => evaluate('v.state.selection.main.head')
  const at = pos => evaluate(`v.dispatch({selection:{anchor:${pos}}});v.focus()`)
  const key = async (key, code = key, modifiers = 0) => {
    const windowsVirtualKeyCode = { Enter: 13, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, KeyZ: 90 }[code]
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode })
    await sleep(30)
  }
  const metrics = () => evaluate(`[...v.contentDOM.querySelectorAll(':scope > .cm-line')].map(el=>{
    const rect=el.getBoundingClientRect(),s=getComputedStyle(el);
    return {text:el.textContent,top:rect.top+parseFloat(s.paddingTop),
      bottom:rect.bottom-parseFloat(s.paddingBottom)-parseFloat(s.borderBottomWidth),height:rect.height,
      blank:el.textContent.trim()===''}
  })`)
  for (const backward of [true, false]) {
    await reset('a\nx\n\nb', backward ? 3 : 2)
    await key(backward ? 'Backspace' : 'Delete')
    const name = backward ? '退格' : '向前删除'
    check(name + ' 删除末字保留分隔字节', await text(), 'a\n\n\nb')
    check(name + ' 空段收起后光标方向及关联正确',
      await evaluate('[v.state.selection.main.head,v.state.selection.main.assoc]'), backward ? [1,-1] : [4,1])
    await send('Input.insertText', { text: 'Z' })
    check(name + ' 后继续输入留在正确段落', await text(), backward ? 'aZ\n\n\nb' : 'a\n\n\nZb')
  }
  const spacingDoc = '第一段\n\n第二段\n\n## 二级\n\n二级正文\n\n### 三级\n\n三级正文\n\n#### 四级\n\n四级正文'
  for (const theme of ['light', 'dark', 'elegant', 'sepia', 'notion', 'bear', 'writer', 'solarized-dark', 'nord', 'gruvbox', 'dracula', 'midnight']) {
    await evaluate(`document.body.className='theme-${theme}'`)
    await reset(spacingDoc)
    const rows = await metrics()
    const font = await evaluate("parseFloat(getComputedStyle(v.contentDOM).fontSize)")
    const gapBefore = value => {
      const i = rows.findIndex(row => row.text === value)
      assert.ok(i > 0, value + ' 未找到，当前行：' + JSON.stringify(rows))
      return rows[i].top - rows[i - 1].bottom
    }
    const close = (actual, factor) => Math.abs(actual - factor * font) < 1.1
    check(theme + ' 正文段距', close(gapBefore('第二段'), 0.5))
    check(theme + ' 标题上方层级', close(gapBefore('二级'), 1.875) && close(gapBefore('三级'), 1.25) && close(gapBefore('四级'), 1))
    check(theme + ' 标题下方', close(gapBefore('三级正文'), 0.625) && close(gapBefore('四级正文'), 0.5))
    check(theme + ' 原文未改', await text(), spacingDoc)
  }
  await evaluate("document.body.className='theme-elegant'")
  for (let blanks = 0; blanks <= 3; blanks++) {
    const doc = '上文\n' + '\n'.repeat(blanks) + '### 标题\n\n下文'
    await reset(doc)
    const rows = await metrics(), title = rows.find(row => row.text === '标题')
    const distance = title.top - rows[0].bottom
    check(blanks + ' 个空行的可见空段数', rows.filter(row => row.blank).length, blanks === 3 ? 1 : 0)
    check(blanks + ' 个空行的标题距离', blanks === 3 ? distance > 45 : Math.abs(distance - 20) < 1)
  }
  // 不能只断言光标大于某个下限：1em 高的占位仍会通过，却矮于正文的真实字体度量。
  const caretCases = [
    ['elegant', 16, 3, 1], ['elegant', 16, 4, 1],
    ['elegant', 16, 5, 2], ['elegant', 16, 10, 4],
    ['elegant', 24, 3, 1], ['dark', 16, 3, 1],
    ['sepia', 16, 3, 1], ['writer', null, 3, 1],
  ]
  for (const [theme, size, blanks, expected] of caretCases) {
    await evaluate(`document.body.className='theme-${theme}';v.contentDOM.style.removeProperty('--editor-font-size')`)
    if (size) await evaluate(`v.contentDOM.style.setProperty('--editor-font-size','${size}px')`)
    const doc = '上文\n' + '\n'.repeat(blanks) + '下文'
    await reset(doc)
    const result = await evaluate(`(() => {
      const lines=[...v.contentDOM.querySelectorAll(':scope > .cm-line')];
      const caretHeight=el=>{const rect=v.coordsAtPos(v.posAtDOM(el,0));return rect.bottom-rect.top};
      const body=caretHeight(lines[0]);
      return {body,empty:lines.filter(el=>!el.textContent.trim()).map(caretHeight),text:v.state.doc.toString()}
    })()`)
    const label = theme + ' ' + (size ?? '默认') + 'px ' + blanks + ' 个空行'
    check(label + ' 空段数量', result.empty.length, expected)
    check(label + ' 空段光标与正文等高', result.empty.every(height => Math.abs(height - result.body) < 0.5))
    check(label + ' 源码未改', result.text, doc)
  }
  await evaluate("v.contentDOM.style.removeProperty('--editor-font-size');document.body.className='theme-elegant'")
  // 复制范围跨过隐藏的分隔，粘贴和撤销仍以源码字节为准。
  const copiedDoc = '前段\n\n### 标题\n\n正文'
  await reset(copiedDoc)
  await evaluate(`v.dispatch({selection:{anchor:0,head:v.state.doc.length}})`)
  const copied = await evaluate(`(() => {
    const data = new DataTransfer();
    v.contentDOM.dispatchEvent(new ClipboardEvent('copy', {clipboardData:data,bubbles:true,cancelable:true}));
    return data.getData('text/plain');
  })()`)
  check('跨隐藏分隔复制保留源码', copied, copiedDoc)
  const target = '开头\n\n结尾'
  await reset(target, 4)
  await evaluate(`(() => {
    const data = new DataTransfer();data.setData('text/plain',${JSON.stringify(copied)});
    v.contentDOM.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
  })()`)
  check('跨隐藏分隔粘贴保留源码', await text(), '开头\n\n' + copiedDoc + '结尾')
  await key('z', 'KeyZ', 4)
  check('粘贴一次撤销恢复原文', await text(), target)
  await reset('前段\n\n### 标题\n\n后段')
  await at(2)
  await key('ArrowRight')
  check('右移跨过分隔空行和标题标记', await head(), 8)
  await send('Input.insertText', { text: '导航' })
  check('右移后输入落在标题文字', await text(), '前段\n\n### 导航标题\n\n后段')
  await reset('前段\n\n### 标题\n\n后段', 8)
  await key('ArrowLeft')
  check('左移跨过分隔空行', await head(), 2)
  await at(8)
  await key('ArrowUp')
  check('标题向上直接到正文', await head() <= 2)
  await at(3)
  check('程序定位保留调用方的精确位置', await head(), 3)
  for (const userEvent of ['select.search', 'undo', 'redo', 'input']) {
    await at(8)
    await evaluate(`v.dispatch({selection:{anchor:3},userEvent:${JSON.stringify(userEvent)},scrollIntoView:true})`)
    check(userEvent + ' 定位不被段落过滤器改写', await head(), 3)
  }
  await evaluate(`v.setState(v.state.constructor.create({
    doc:'前段\\n\\n### 标题\\n\\n后段',
    selection:v.state.selection.constructor.create([
      v.state.selection.constructor.cursor(0),v.state.selection.constructor.cursor(10)
    ],1),
    extensions:[v.state.config.base,v.state.constructor.allowMultipleSelections.of(true)]
  }));v.dispatch({selection:v.state.selection.constructor.create([
    v.state.selection.constructor.cursor(3),v.state.selection.constructor.cursor(6)
  ],1),userEvent:'select'});void 0`)
  check('多光标各自保留原始落点和主范围', await evaluate('[...v.state.selection.ranges.map(r=>r.head),v.state.selection.mainIndex]'), [3,6,1])
  await reset('前段\n\n### 标题\n\n后段')
  await evaluate('v.dispatch({selection:{anchor:2,head:9}})')
  check('非空选区保留原始字节范围', await evaluate('[v.state.selection.main.from,v.state.selection.main.to]'), [2, 9])
  await at(0)
  const point = await evaluate(`(()=>{
    const line=[...v.contentDOM.children].find(el=>el.textContent==='标题'),r=line.getBoundingClientRect();
    return {x:r.left+2,y:r.top+parseFloat(getComputedStyle(line).paddingTop)/2}
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  await send('Input.insertText', { text: '落点' })
  check('点击标题留白后输入落在标题', (await text()).includes('### 落点标题'))

  await reset('前段\n\n后段', 2)
  await key('Enter')
  const middleCaret = await evaluate('(()=>{const r=v.coordsAtPos(v.state.selection.main.head);return r.bottom-r.top})()')
  check('中间空段光标保持正常高度', middleCaret > 15)
  await send('Input.insertText', { text: '新段' })
  check('Enter 新建段落', await text(), '前段\n\n新段\n\n后段')
  await key('z', 'KeyZ', 4)
  await key('z', 'KeyZ', 4)
  check('撤销回到原始字节', await text(), '前段\n\n后段')
  await key('Z', 'KeyZ', 12)
  await key('Z', 'KeyZ', 12)
  check('重做恢复新段落', await text(), '前段\n\n新段\n\n后段')
  await reset('前段', 2)
  await key('Enter')
  check('文末 Enter 只有一个可见空段', (await metrics()).filter(row => row.blank).length, 1)
  const caret = await evaluate('(()=>{const r=v.coordsAtPos(v.state.selection.main.head);return {top:r.top,bottom:r.bottom}})()')
  check('文末空段光标有正常高度', caret.bottom - caret.top > 15)
  await send('Input.insertText', { text: '尾段' })
  check('文末空段可输入', await text(), '前段\n\n尾段')
  await reset('前段', 2)
  for (let i = 0; i < 3; i++) await key('Enter')
  check('连续三次 Enter 保留三个空段', (await metrics()).filter(row => row.blank).length, 3)
  await send('Input.insertText', { text: '末段' })
  check('连续空段中输入保留换行位置', await text(), '前段' + '\n'.repeat(6) + '末段')
  await reset('')
  await key('Enter')
  check('空文档回车只新增一行', (await metrics()).filter(row => row.blank).length, 2)
  await reset('### 标题', 4)
  await key('Enter')
  check('标题开头回车保留标题', await text(), '\n\n### 标题')
  check('标题开头回车只新增一个空段', (await metrics()).filter(row => row.blank).length, 1)
  await reset('前段', 2)
  await key('Enter', 'Enter', 8)
  await send('Input.insertText', { text: '换行' })
  check('Shift+Enter 仅段内换行', await text(), '前段\n换行')
  await reset('前段\n\n后段', 4)
  await key('Backspace')
  check('Backspace 一次合并正文', await text(), '前段后段')
  await reset('前段\n\n后段', 2)
  await key('Delete')
  check('Delete 一次合并正文', await text(), '前段后段')
  await reset('前段\n\n### 标题', 8)
  await key('Backspace')
  check('标题开头先退成正文', await text(), '前段\n\n标题')
  await reset('前段\n\n### 标题', 2)
  await key('Delete')
  check('向前合并不泄露标题标记', await text(), '前段标题')
  await reset('中文', 2)
  await send('Input.imeSetComposition', { text: '拼', selectionStart: 1, selectionEnd: 1 })
  await send('Input.insertText', { text: '拼音' })
  check('中文组合输入', await text(), '中文拼音')
  const fence = String.fromCharCode(96).repeat(3)
  const codeDoc = fence + 'text\n代码甲\n\n代码乙\n' + fence
  await reset(codeDoc, codeDoc.indexOf('代码甲') + 3)
  await key('Enter')
  check('代码块 Enter 保持单换行', await text(), codeDoc.replace('代码甲', '代码甲\n'))
  check('代码内部空行保留', (await metrics()).some(row => row.blank))
  await reset('- 第一项', 5)
  await key('Enter')
  check('列表 Enter 照常续项', await text(), '- 第一项\n- ')
  const math = '$$\na\n\nb\n$$'
  await reset(math, 4)
  await key('Enter')
  check('块公式内部不插段落分隔', await text(), math.slice(0, 4) + '\n' + math.slice(4))
  const full = '---\ntitle: 保真\n\n---\n\n# 标题\n\n正文\n\n\n\n下一段\n'
  await reset(full)
  await evaluate("document.getElementById('source-toggle-btn').click()")
  await sleep(80)
  check('源码模式逐字保留空行', await evaluate("document.getElementById('source-editor').value"), full)
  await evaluate("document.getElementById('source-toggle-btn').click()")
  await sleep(80)
  check('模式往返逐字保真', await text(), full)

  // 与复杂块相邻的分隔会收起，但块内部的结构、源码和光标不动。
  for (const block of ['> 引用甲\n>\n> 引用乙', '- 列表甲\n\n- 列表乙', codeDoc, '| 甲 |\n| --- |\n| 乙 |', '<div>HTML</div>']) {
    const doc = '### 节名\n\n' + block + '\n\n末段'
    await reset(doc)
    check('复杂块边界不改原文 ' + block.slice(0, 12), await text(), doc)
    check('复杂块边界有排版间距 ' + block.slice(0, 12), await evaluate("!!v.contentDOM.querySelector('.cm-md-block-space')"))
  }
  await reset(spacingDoc)
  await evaluate("v.contentDOM.style.setProperty('--editor-font-size','24px')")
  await sleep(60)
  const large = await metrics(), largeIndex = large.findIndex(row => row.text === '三级')
  check('放大字号后标题间距跟随字号', Math.abs(large[largeIndex].top - large[largeIndex - 1].bottom - 30) < 1)
  await evaluate("v.contentDOM.style.removeProperty('--editor-font-size')")
  // 等待已有用户输入的自动保存落盘，再用外部修改驱动真实的文件监听。
  await sleep(800)
  const externallyWritten = '外部第一段\n\n### 外部标题\n\n外部正文\n'
  writeFileSync(fixture, externallyWritten)
  for (let i = 0; i < 60 && await text() !== externallyWritten; i++) await sleep(100)
  check('外部文件更新刷新排版且保真', await text(), externallyWritten)
  check('外部更新后无额外空行', (await metrics()).filter(row => row.blank).length <= 1)
  const screenshotDir = process.argv[process.argv.indexOf('--screenshots') + 1]
  if (process.argv.includes('--screenshots') && screenshotDir) {
    mkdirSync(resolve(screenshotDir), { recursive: true })
    const sample = '# 标题与段落排版\n\n' + spacingDoc + '\n\n' + codeDoc + '\n\n- 第一项\n- 第二项\n'
    for (const theme of ['elegant', 'dark']) {
      await evaluate(`document.body.className='theme-${theme}'`)
      await reset(sample)
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(resolve(screenshotDir), theme + '-after.png'), Buffer.from(data, 'base64'))
    }
  }
  console.log(`段落排版验收通过：${count} 项。`)
} finally {
  socket?.close()
  stopVerifyApp(udd)
  app.kill()
}
