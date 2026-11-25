import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp } from './verify-workdir.mjs'

assertBuildFresh()
const root = fileURLToPath(new URL('..', import.meta.url))
const directory = mkdtempSync('/tmp/colamd-table-caret-')
const output = process.env.COLAMD_CARET_OUTPUT
if (output) mkdirSync(output, { recursive: true })
const baseline = process.argv.includes('--baseline')
const file = join(directory, 'caret.md')
writeFileSync(file, '光标验证\n')
const launcher = join(directory, 'launch.cjs')
writeFileSync(launcher, `require(${JSON.stringify(join(root, 'scripts/offscreen-window.cjs'))})`)
const port = 10100 + Math.floor(Math.random() * 200)
const electron = createRequire(import.meta.url)('electron')
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [launcher, file, `--user-data-dir=${directory}/profile`, `--remote-debugging-port=${port}`], { cwd: root, env: environment, stdio: 'ignore' })
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
let socket, sequence = 0, passed = 0
const failures = [], runtimeErrors = [], pending = new Map()
const check = (name, valid, detail) => {
  if (valid) { passed++; console.log(`PASS ${name}`) }
  else { failures.push({ name, detail }); console.log(`FAIL ${name} ${JSON.stringify(detail)}`) }
}
try {
  let page
  for (let attempt = 0; attempt < 150 && !page; attempt++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.type === 'page') } catch {}
    if (!page) await pause(100)
  }
  assert(page, 'Electron 未启动')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject) })
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params)
    if (!message.id) return
    const request = pending.get(message.id)
    pending.delete(message.id)
    if (!request) return
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }, 30000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let attempt = 0; attempt < 100 && !(await evaluate(`!!document.querySelector('#editor .cm-content')`)); attempt++) await pause(100)
  await evaluate(`window.v=document.querySelector('#editor .cm-content').cmTile.root.view; v.focus()`)
  const key = async (name, modifiers = 0) => {
    const codes = { Enter: 13, Tab: 9, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, z: 90, Backspace: 8 }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, windowsVirtualKeyCode: codes[name], modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, modifiers })
    await pause(60)
  }
  const mod = process.platform === 'darwin' ? 4 : 2
  const setDoc = async text => {
    await evaluate(`v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(text)}},selection:{anchor:0}});v.focus();v.scrollDOM.scrollTop=0`)
    await pause(220)
  }
  const select = async (text, offset = text.length, length = 0) => {
    await evaluate(`(()=>{const anchor=v.state.doc.toString().indexOf(${JSON.stringify(text)})+${offset};v.dispatch({selection:{anchor,head:anchor+${length}}});v.focus()})()`)
    await pause(100)
  }
  const paste = async text => {
    await evaluate(`(()=>{const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(text)});document.activeElement.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))})()`)
    await pause(150)
  }
  const click = async (row, column) => {
    const point = await evaluate(`(()=>{const cell=v.contentDOM.querySelector('[data-table-row="${row}"] [data-column="${column}"]'),rect=cell.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+16}})()`)
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    await pause(100)
  }
  await evaluate(`window.box=rect=>rect&&({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom});window.visibleCaret=()=>{const input=document.activeElement;if(input.matches?.('.cm-md-table-input')){const rect=input.getBoundingClientRect(),align=getComputedStyle(input).textAlign,left=align==='center'?(rect.left+rect.right)/2:align==='right'?rect.right:rect.left;return {left,right:left,top:rect.top,bottom:rect.bottom}}const cursor=v.dom.querySelector('.cm-cursor');return cursor&&box(cursor.getBoundingClientRect())}`)
  const state = () => evaluate(`(()=>{const range=v.state.selection.main,caret=box(v.coordsAtPos(range.head,range.assoc||1));return {doc:v.state.doc.toString(),selection:v.state.selection.toJSON(),head:range.head,assoc:range.assoc,caret,scroll:v.scrollDOM.scrollTop}})()`)
  const geometry = (row, column) => evaluate(`(()=>{const cell=v.contentDOM.querySelector('[data-table-row="${row}"] [data-column="${column}"]'),rect=cell.getBoundingClientRect(),style=getComputedStyle(cell),range=v.state.selection.main,caret=visibleCaret();let from=v.posAtDOM(cell,0),to=v.posAtDOM(cell,cell.childNodes.length),source=v.state.doc.sliceString(from,to);if(source.startsWith('|'))from++;if(source.endsWith('|'))to--;while(from<to&&/[ \\t]/.test(v.state.doc.sliceString(from,from+1)))from++;while(to>from&&/[ \\t]/.test(v.state.doc.sliceString(to-1,to)))to--;return {head:range.head,source:{from,to},caret,sourceCaret:box(v.coordsAtPos(range.head,range.assoc||1)),cell:{left:rect.left+parseFloat(style.paddingLeft),right:rect.right-parseFloat(style.paddingRight),top:rect.top,bottom:rect.bottom},html:cell.innerHTML}})()`)
  const inside = async (name, row, column) => {
    const result = await geometry(row, column), { caret, cell } = result
    check(name, caret && caret.left >= cell.left - 2 && caret.left <= cell.right + 2 && caret.top >= cell.top - 1 && caret.bottom <= cell.bottom + 1, result)
    check(`${name} 源码在同格`, result.head >= result.source.from && result.head <= result.source.to, result)
    if (!result.html.includes('cm-md-table-input')) check(`${name} 绘制光标与实时坐标一致`, caret && result.sourceCaret && Math.abs(caret.left - result.sourceCaret.left) <= 2 && Math.abs(caret.top - result.sourceCaret.top) <= 2, result)
  }
  const screenshot = async name => {
    if (!output) return
    await pause(80)
    const image = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, `${name}.png`), Buffer.from(image.data, 'base64'))
  }
  const fixture = '| A | B | C |\n|---|---|---|\n| first | 第一句 | tail |\n| missing |\n\n正文\n'
  await setDoc(fixture)
  await select('第一句')
  const beforeBreak = await state()
  await key('Enter', 8)
  const afterBreak = await state()
  check('06 换行立即显示第二行光标', afterBreak.caret.top > beforeBreak.caret.top + 10, { beforeBreak, afterBreak })
  await inside('06 光标仍在当前格', 1, 1)
  await screenshot('06-break')
  await key('ArrowLeft')
  check('06 左键跨过整段换行标记', (await state()).head === beforeBreak.head, await state())
  await key('ArrowRight')
  check('06 左右跨换行往返', (await state()).head === afterBreak.head, await state())
  await key('ArrowUp')
  const upBreak = await state()
  check('06 上键先走格内上一行', upBreak.head >= beforeBreak.head - 3 && upBreak.head <= beforeBreak.head, upBreak)
  await key('ArrowDown')
  check('06 上下往返', (await state()).head === afterBreak.head, await state())

  await setDoc(Array.from({ length: 9 }, (_, index) => `段落 ${index}\n\n`).join('') + fixture)
  await evaluate(`v.contentDOM.querySelector('[data-table-row="2"]').scrollIntoView({block:'center'})`)
  await pause(200)
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await state()
    await click(2, 2)
    const after = await state()
    check(`10 可见缺省格点击 ${attempt} 不滚动`, after.scroll === before.scroll, { before: before.scroll, after: after.scroll })
  }
  await inside('10 缺省格光标位置', 2, 2)
  await screenshot('10-missing')

  await setDoc('| 名称 | 数量 |\n| --- | --- |\n| 起点 | 0 |\n\n正文\n')
  await select('起点', 0)
  await paste('绿茶\t12\t杭州\n咖啡\t8\t上海')
  const afterTSV = await state()
  check('25 TSV 保留表头', afterTSV.doc.startsWith('| 名称 | 数量 |'), afterTSV)
  check('25 TSV 最后格末源码落点', afterTSV.head === afterTSV.doc.indexOf('上海') + 2, afterTSV)
  await inside('25 TSV 最后格末视觉落点', 2, 2)
  await screenshot('25-tsv')

  await setDoc('| 粘贴位置 | 邻格代码 |\n| --- | --- |\n| 在这里粘贴 | `c|d` |\n|  | `e|f` |\n\n正文\n')
  await select('c|d')
  const beforePaste = await state()
  await paste('甲|乙 \\ 路径 `未闭合')
  const pastedCode = await state()
  check('27 粘贴落点不跨过原来的代码结束标记', pastedCode.head === pastedCode.doc.indexOf('未闭合') + 3, pastedCode)
  await key('z', mod)
  const afterUndo = await state()
  check('27 撤销文档等于粘贴前', afterUndo.doc === beforePaste.doc, { beforePaste, afterUndo })
  check('27 撤销选区等于粘贴前', JSON.stringify(afterUndo.selection) === JSON.stringify(beforePaste.selection) && afterUndo.assoc === beforePaste.assoc, { beforePaste, afterUndo })
  await inside('27 撤销视觉落点', 1, 1)
  await pause(250)
  const codeCaret = await evaluate(`(()=>{const cell=v.contentDOM.querySelector('[data-table-row="1"] [data-column="1"]'),walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let text;while(text=walker.nextNode()){const offset=text.textContent.indexOf('d');if(offset<0)continue;const range=document.createRange();range.setStart(text,offset+1);range.collapse(true);return {glyph:box(range.getBoundingClientRect()),caret:visibleCaret(),html:cell.innerHTML,assoc:v.state.selection.main.assoc,positions:[-1,1].map(side=>box(v.coordsAtPos(v.state.selection.main.head,side)))}}})()`)
  check('27 撤销光标紧贴 d 字形末尾', Math.abs(codeCaret.glyph.right - codeCaret.caret.left) <= 2, codeCaret)
  await screenshot('27-undo')
  await send('Input.insertText', { text: 'Q' })
  const typedBeforePaste = await state()
  await paste('甲|乙 \\ 路径 `未闭合')
  await key('z', mod)
  const undoAfterTyping = await state()
  check('27 粘贴撤销不吞并之前输入', undoAfterTyping.doc === typedBeforePaste.doc && JSON.stringify(undoAfterTyping.selection) === JSON.stringify(typedBeforePaste.selection), { typedBeforePaste, undoAfterTyping })
  if (!baseline || process.argv.includes('--all')) {
    await setDoc('| A | B |\n|---|---|\n| 苹果 | 内容 |\n\n正文\n')
    await select('苹果')
    for (const text of [' ', 'test', ' ', 'word']) {
      await send('Input.insertText', { text })
      await pause(70)
    }
    check('连续空格和单词保持输入次序', (await state()).doc.includes('苹果 test word'), await state())
    for (const offset of [0, 1, 2, 3]) {
      await setDoc('| A | B |\n|---|---|\n| `c|d` | end |\n\n正文\n')
      await select('c|d', offset)
      const before = await state()
      await paste('甲|乙 \\ 路径 `未闭合')
      const after = await state()
      check(`27 代码格偏移 ${offset} 粘贴末尾`, after.head === after.doc.indexOf('未闭合') + 3, { before, after })
      await inside(`27 代码格偏移 ${offset} 视觉`, 1, 0)
      await key('z', mod)
      check(`27 代码格偏移 ${offset} 撤销`, (await state()).doc === before.doc && JSON.stringify((await state()).selection) === JSON.stringify(before.selection), { before, after: await state() })
    }
    for (const composing of [false, true]) for (const offset of [0, 1, 2, 3]) {
      await setDoc('| A | B |\n|---|---|\n| `c|d` | end |\n\n正文\n')
      await select('c|d', offset)
      const before = await state()
      const label = `${composing ? '组字提交' : '原生输入'}代码格 ${offset}`
      if (composing) await send('Input.imeSetComposition', { text: 'jia', selectionStart: 3, selectionEnd: 3 })
      await send('Input.insertText', { text: '甲|乙 \\ 路径 `未闭合' })
      await pause(120)
      const after = await state()
      check(`${label} 插入末尾`, after.head === after.doc.indexOf('未闭合') + 3, { before, after })
      await inside(`${label} 视觉`, 1, 0)
      await key('z', mod)
      check(`${label} 撤销`, (await state()).doc === before.doc && JSON.stringify((await state()).selection) === JSON.stringify(before.selection) && (await state()).assoc === before.assoc, { before, after: await state() })
      await inside(`${label} 撤销视觉`, 1, 0)
      await key('z', mod | 8)
      const redone = await state()
      check(`${label} 重做`, redone.doc === after.doc && JSON.stringify(redone.selection) === JSON.stringify(after.selection) && redone.caret && after.caret && Math.abs(redone.caret.left - after.caret.left) <= 2 && Math.abs(redone.caret.top - after.caret.top) <= 2, { after, redone })
      await inside(`${label} 重做视觉`, 1, 0)
    }
    await setDoc('| A | B |\n|---|---|\n| **前后** | 内容 |\n\n正文\n')
    for (const direction of [1, -1]) {
      await select('前后', direction > 0 ? 0 : 2, direction > 0 ? 2 : -2)
      const before = await state()
      await paste('甲|乙\n第二行')
      await inside(`正反选区 ${direction} 粘贴`, 1, 0)
      await key('z', mod)
      check(`正反选区 ${direction} 撤销保留方向`, (await state()).doc === before.doc && JSON.stringify((await state()).selection) === JSON.stringify(before.selection), { before, after: await state() })
    }
    const contexts = [
      { name: '普通', first: '', continuation: '' },
      { name: '引用', first: '> ', continuation: '> ' },
      { name: '列表', first: '- ', continuation: '  ' },
      { name: '引用列表', first: '> - ', continuation: '>   ' },
    ]
    const equalSelection = (left, right) => JSON.stringify(left.selection) === JSON.stringify(right.selection) && left.assoc === right.assoc
    const sourceInvariant = async name => {
      const result = await evaluate(`(()=>{const range=v.state.selection.main,line=v.state.doc.lineAt(range.head);return {head:range.head,line:line.text,offset:range.head-line.from,text:v.state.doc.sliceString(range.head-1,range.head+1)}})()`)
      check(name, result.offset >= result.line.search(/\|/) && result.head >= 0 && result.head <= (await state()).doc.length, result)
    }
    let randomState = 0x27ca4e7
    const random = limit => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return (randomState >>> 16) % limit }
    const operationCounts = new Map()
    for (const context of contexts) {
      const table = `${context.first}| 左列 | 中列 | 右列 |\n${context.continuation}|---|---|---|\n${context.continuation}| 左侧 | 目标 | 右侧 |\n${context.continuation}| 下一 | 其它 | 末格 |\n${context.continuation}| 缺省 |\n\n正文\n`
      await setDoc(table)
      await select('目标')
      for (let attempt = 0; attempt < 32; attempt++) {
        const operation = random(8)
        operationCounts.set(operation, (operationCounts.get(operation) ?? 0) + 1)
        const label = `${context.name} 随机 ${attempt}/${operation}`
        await select('目标')
        if (operation === 0) {
          const before = await state()
          await key('ArrowLeft'); await key('ArrowRight')
          check(`${label} 左右往返`, equalSelection(before, await state()), { before, after: await state() })
        } else if (operation === 1) {
          await key('ArrowUp'); const before = await state()
          await key('ArrowDown'); await key('ArrowUp')
          check(`${label} 上下往返`, equalSelection(before, await state()), { before, after: await state() })
          await inside(`${label} 表头光标`, 0, 1)
        } else if (operation === 2) {
          await key('Tab'); const before = await state()
          await key('Tab', 8); await key('Tab')
          check(`${label} Tab 往返`, equalSelection(before, await state()), { before, after: await state() })
          await inside(`${label} Tab 落点`, 1, 2)
        } else if (operation === 3) {
          await key('Enter')
          await inside(`${label} Enter 下一行`, 2, 1)
          await sourceInvariant(`${label} Enter 源码落点`)
        } else if (operation === 4) {
          const before = await state()
          await key('Enter', 8)
          const after = await state()
          check(`${label} 空第二行`, after.caret.top > before.caret.top + 10, { before, after })
          await inside(`${label} 换行落点`, 1, 1)
          await key('ArrowUp'); await key('ArrowDown')
          check(`${label} 格内上下往返`, (await state()).head === after.head, { after, returned: await state() })
          await key('z', mod)
          check(`${label} 换行撤销`, (await state()).doc === before.doc && equalSelection(before, await state()), { before, after: await state() })
        } else if (operation === 5 || operation === 6) {
          const texts = ['普通文字', '首行\n次行', '甲|乙 \\ 路径 `未闭合', '`a|b`', '绿茶\t12\t杭州\n咖啡\t8\t上海']
          const text = texts[random(texts.length)]
          const before = await state()
          await paste(text)
          const after = await state()
          check(`${label} 粘贴实际输入`, after.doc !== before.doc, { text, before, after })
          await inside(`${label} 粘贴视觉位置`, text.includes('\t') ? 2 : 1, text.includes('\t') ? 3 : 1)
          await sourceInvariant(`${label} 粘贴源码落点`)
          await key('z', mod)
          check(`${label} 粘贴撤销选区`, (await state()).doc === before.doc && equalSelection(before, await state()), { text, before, after: await state() })
          await key('z', mod | 8)
          check(`${label} 粘贴重做选区`, (await state()).doc === after.doc && equalSelection(after, await state()), { text, after, redone: await state() })
          await key('z', mod)
        } else {
          await click(3, 2)
          const before = await state()
          await send('Input.insertText', { text: '补格' })
          await pause(120)
          await inside(`${label} 补格输入位置`, 3, 2)
          await key('z', mod)
          check(`${label} 缺省格撤销`, (await state()).doc === before.doc && equalSelection(before, await state()), { before, after: await state() })
          await inside(`${label} 撤销恢复虚拟格身份`, 3, 2)
        }
      }
      for (const column of [1, 2]) {
        await click(3, column)
        const before = await state()
        await paste('甲|乙 \\ 路径 `未闭合')
        const after = await state()
        await inside(`${context.name} 缺省格 ${column} 粘贴`, 3, column)
        await key('z', mod)
        check(`${context.name} 缺省格 ${column} 撤销源码与选区`, (await state()).doc === before.doc && equalSelection(before, await state()), { before, after: await state() })
        await inside(`${context.name} 缺省格 ${column} 撤销视觉`, 3, column)
        await key('z', mod | 8)
        check(`${context.name} 缺省格 ${column} 重做`, (await state()).doc === after.doc && equalSelection(after, await state()), { after, redone: await state() })
        await key('z', mod)
      }
      await select('末格')
      await key('Tab')
      await send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
      await send('Input.insertText', { text: '中文' })
      await pause(160)
      await inside(`${context.name} 缺省格组字提交`, 3, 0)
      check(`${context.name} 组字文本写入`, (await state()).doc.includes('中文'), await state())
    }
    check('固定种子覆盖所有随机操作', operationCounts.size === 8, [...operationCounts])
    await setDoc('| 左列 | 中列 | 右列 |\n|---|---|---|\n| 左侧 | 目标 | 右侧 |\n| 下一 | 其它 | 末格 |\n\n正文\n')
    for (let attempt = 0; attempt < 24; attempt++) {
      const point = await evaluate(`(()=>{const walker=document.createTreeWalker(v.contentDOM,NodeFilter.SHOW_TEXT);for(let node;node=walker.nextNode();){const offset=node.textContent.indexOf('目标');if(offset<0)continue;const range=document.createRange();range.setStart(node,offset+2);range.collapse(true);const rect=range.getBoundingClientRect();return {x:rect.left+0.1,y:(rect.top+rect.bottom)/2,expected:v.posAtDOM(node,offset+2)}}throw Error('目标未渲染')})()`)
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await pause(80)
      check(`累积编辑 ${attempt} 实际鼠标落点`, (await state()).head === point.expected, { point, state: await state() })
      const before = await state()
      const operation = random(4)
      if (operation === 0) {
        await send('Input.insertText', { text: `字${attempt}` })
        await pause(80)
      } else if (operation === 1) {
        await paste(['甲|乙', '第一行\n第二行', '反引号`与\\路径'][random(3)])
      } else if (operation === 2) {
        await paste('P')
        const after = await state()
        await key('z', mod)
        check(`累积编辑 ${attempt} 撤销`, (await state()).doc === before.doc && equalSelection(before, await state()), { before, after: await state() })
        await key('z', mod | 8)
        check(`累积编辑 ${attempt} 重做`, (await state()).doc === after.doc && equalSelection(after, await state()), { after, redone: await state() })
      } else {
        await key('Enter', 8)
        await send('Input.insertText', { text: '续' })
        await pause(100)
      }
      await inside(`累积编辑 ${attempt} 光标`, 1, 1)
      check(`累积编辑 ${attempt} 表头保持`, (await state()).doc.startsWith('| 左列 | 中列 | 右列 |'), await state())
    }
    for (const trailing of [true, false]) for (const origin of [0, 1]) {
      const table = trailing ? '| 名称 | 数量 |\n| --- | --- |\n| 起点 | 0 |\n\n正文\n' : '名称 | 数量\n--- | ---\n起点 | 0\n\n正文\n'
      await setDoc(table)
      await click(origin, 0)
      const before = await state()
      await paste('绿茶\t12\t杭州\n咖啡\t8\t上海')
      const after = await state()
      check(`TSV 尾线 ${trailing} 起行 ${origin} 落点`, after.head === after.doc.indexOf('上海') + 2, after)
      check(`TSV 尾线 ${trailing} 起行 ${origin} 表头`, origin === 0 ? after.doc.split('\n')[0].includes('绿茶') : after.doc.split('\n')[0].includes('名称'), after)
      await inside(`TSV 尾线 ${trailing} 起行 ${origin} 视觉`, origin + 1, 2)
      await key('z', mod)
      check(`TSV 尾线 ${trailing} 起行 ${origin} 撤销`, (await state()).doc === before.doc && equalSelection(before, await state()), { before, after: await state() })
    }
  }
  await setDoc('> ```\n> 引用甲。\n>\n> 引用乙。\n> ```')
  await select('引用甲', 0)
  const longDocument = Array.from({ length: 28 }, (_, index) => `段落${index}\n\n| H | V |\n|---|---|\n| 前表${index} | value |\n\n`).join('') + '末尾光标目标\n'
  await evaluate(`v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(longDocument)}},selection:{anchor:0}})`)
  await pause(150)
  await evaluate(`(()=>{const position=v.state.doc.toString().indexOf('末尾光标目标');v.scrollDOM.scrollTop=v.lineBlockAt(position).top-120;v.requestMeasure();v.coordsAtPos(position)})()`)
  for (let attempt = 0; attempt < 30; attempt++) {
    await pause(80)
    if (await evaluate(`v.contentDOM.textContent.includes('末尾光标目标')`)) break
  }
  const longViewport = await evaluate(`(()=>{const walker=document.createTreeWalker(v.contentDOM,NodeFilter.SHOW_TEXT),viewport=v.scrollDOM.getBoundingClientRect();for(let node;node=walker.nextNode();)if(node.textContent.includes('末尾光标目标')){const rect=node.parentElement.getBoundingClientRect();return {visible:rect.bottom>=viewport.top&&rect.top<=viewport.bottom,rect:box(rect),scroll:v.scrollDOM.scrollTop,viewport:v.viewport}}return {visible:false,scroll:v.scrollDOM.scrollTop,viewport:v.viewport}})()`)
  check('多表长文列宽刷新不拉回旧选区视口', longViewport.visible, longViewport)
  check('运行时无异常', !runtimeErrors.length, runtimeErrors)
  const result = { baseline, passed, failures, runtimeErrors }
  if (output) writeFileSync(join(output, baseline ? 'baseline.json' : 'invariants.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  if (!baseline) assert.equal(failures.length, 0, `${failures.length} 项光标检查失败`)
} finally {
  socket?.close()
  for (const request of pending.values()) clearTimeout(request.timer)
  child.kill('SIGTERM')
  stopVerifyApp(`${directory}/profile`)
  rmSync(directory, { recursive: true, force: true })
}
