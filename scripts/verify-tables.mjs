import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

assertBuildFresh()
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const electron = createRequire(import.meta.url)('electron')
const { dir, udd } = verifyWorkdir('tables')
const file = join(dir, 'tables.md')
const fixture = '# 单元格编辑\n\n| 名称 | 内容 | 数量 |\n| :--- | :---: | ---: |\n| 苹果 | **加粗**和 `代码` | 123 |\n|| 空格子 | |\n| 缺省 |\n\n表格后的正文。\n'
writeFileSync(file, fixture)
const port = 9940 + Math.floor(Math.random() * 10)
const inspect = port + 1000
// user-data-dir 不隔离主进程的 ~/.colamd；正式回归也不应改用户的最近文件和主题。
const isolatedHome = join(dir, 'home')
mkdirSync(isolatedHome, { recursive: true })
const launcher = join(dir, 'launch.cjs')
writeFileSync(launcher, `const {app}=require('electron');app.setPath('home',${JSON.stringify(isolatedHome)});if(process.env.COLAMD_VERIFY_VISIBLE==='1'){app.on('browser-window-created',(_event,win)=>win.webContents.setBackgroundThrottling(false));require(${JSON.stringify(join(ROOT, 'dist/main/index.js'))})}else require(${JSON.stringify(join(ROOT, 'scripts/offscreen-window.cjs'))})`)
const child = spawn(electron, [launcher, file, `--user-data-dir=${udd}`, `--remote-debugging-port=${port}`, `--inspect=${inspect}`], { cwd: ROOT, stdio: 'ignore' })
let measure = async () => {}
const sleep = async ms => {
  await new Promise(resolve => setTimeout(resolve, ms))
  await measure()
}
let ws, mainWS, passed = 0
const errors = []
const check = (name, value, detail = '') => {
  assert(value, `${name}: ${detail}`)
  passed++
  console.log(`PASS ${name}`)
}
try {
  let page
  for (let i = 0; i < 150; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.type === 'page') } catch {}
    if (page) break
    await sleep(100)
  }
  assert(page, '测试窗口未启动')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', async event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push({ message: message.params.args.map(arg=>arg.description || arg.value), context: await evaluate(`({ text: v.state.doc.toString().slice(0, 120), orphans: [...v.contentDOM.querySelectorAll('.cm-md-table-row')].filter(row => !row.closest('.cm-md-table-widget')).map(row => row.textContent) })`) })
    if (!message.id) return
    const request = pending.get(message.id)
    pending.delete(message.id)
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails))
    return response.result.value
  }
  let mainTarget
  for (let i = 0; i < 100 && !mainTarget; i++) {
    try { mainTarget = (await (await fetch(`http://127.0.0.1:${inspect}/json/list`)).json()).find(target => target.type === 'node') } catch {}
    if (!mainTarget) await sleep(100)
  }
  assert(mainTarget, '主进程调试连接未启动')
  mainWS = new WebSocket(mainTarget.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { mainWS.addEventListener('open', resolve); mainWS.addEventListener('error', reject) })
  const mainEval = async expression => {
    const requestId = ++id
    const reply = new Promise(resolve => {
      const receive = event => {
        const message = JSON.parse(event.data)
        if (message.id !== requestId) return
        mainWS.removeEventListener('message', receive)
        resolve(message)
      }
      mainWS.addEventListener('message', receive)
    })
    mainWS.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    const response = await reply
    assert(!response.error && !response.result.exceptionDetails, JSON.stringify(response))
    return response.result.result?.value
  }
  const ELECTRON = "process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron')"
  const sendToWindow = (channel, payload) => mainEval(`${ELECTRON}.BrowserWindow.getAllWindows()[0].webContents.send(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`)
  const setTheme = async (name, css) => {
    // 走菜单/自定义主题实际使用的 IPC，验证 applyTheme 的完整通知路径。
    await sendToWindow('set-theme', name)
    if (css !== undefined) await sendToWindow('set-custom-css', css)
    await sleep(150)
  }
  await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`!!document.querySelector('.cm-md-table-header')`)) break
    await sleep(100)
  }
  await evaluate(`window.v = document.querySelector('#editor .cm-content').cmTile.root.view; v.focus()`)
  measure = () => evaluate('v.requestMeasure(); v.coordsAtPos(v.state.selection.main.head); undefined')
  const doc = () => evaluate('v.state.doc.toString()')
  const key = async (key, modifiers = 0) => {
    const codes = { Tab: 9, Enter: 13, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, z: 90, a: 65, Home: 36, End: 35 }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: codes[key], modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers })
    await sleep(30)
  }
  const MOD = process.platform === 'darwin' ? 4 : 2
  const setDoc = async text => {
    await evaluate(`v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(text)}},selection:{anchor:0}})`)
    await sleep(150)
  }
  const select = async (text, offset = 0, length = 0) => evaluate(`(() => {
    const anchor = v.state.doc.toString().indexOf(${JSON.stringify(text)}) + ${offset}
    v.dispatch({selection:{anchor,head:anchor+${length}}});v.focus()
  })()`)
  const clickCell = async (row, column, fraction = 0) => {
    const box = await evaluate(`(() => {
      const cell = document.querySelectorAll('.cm-md-table-row')[${row}].querySelectorAll('.cm-md-table-cell')[${column}]
      cell.scrollIntoView({block:'center'})
      const r=cell.getBoundingClientRect();return {x:r.left+Math.max(14,r.width*${fraction}),y:r.top+18}
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...box, button: 'left', clickCount: 1 })
    await sleep(50)
  }
  const type = text => send('Input.insertText', { text })
  const paste = text => evaluate(`(() => {const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(text)});v.contentDOM.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))})()`)
  const exportHTML = () => evaluate('window.__colamdExportDocumentHTML()')
  const head = () => evaluate('v.state.selection.main.head')

  // 每个缺陷可单独运行，避免首条失败挡住其余修复前证据。
  const regression = process.argv.find(arg => arg.startsWith('--regression='))?.split('=')[1]
  const regressions = {
    async adjacentParagraph() {
      for (const prefix of ['', '> ']) for (const direction of ['ArrowUp','ArrowDown']) {
        const source = `${prefix}前文\n${prefix.trimEnd()}\n${prefix}| A | B |\n${prefix}|---|---|\n${prefix}| text | value |\n${prefix.trimEnd()}\n${prefix}后文\n`
        await setDoc(source)
        await select(direction==='ArrowUp'?'A':'value')
        await key(direction)

        const line=await evaluate('v.state.doc.lineAt(v.state.selection.main.head).number')
        check(`${prefix?'引用':'普通'}${direction} 跨过分隔行`,line===(direction==='ArrowUp'?1:7))
        // 鼠标依然可以点到分隔，因此直接输入和中文组字的写入保护必须独立验证。
        const point=await evaluate(`(()=>{const l=v.state.doc.line(${direction==='ArrowUp'?2:6}),b=v.coordsAtPos(l.to);return {x:b.left+1,y:(b.top+b.bottom)/2}})()`)
        for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})
        check('鼠标仍可落在相邻分隔行',await evaluate('v.state.doc.lineAt(v.state.selection.main.head).number')===(direction==='ArrowUp'?2:6))
        await type('正文')
        check('分隔行首次输入仍保留原表格',await evaluate(`v.contentDOM.querySelectorAll('.cm-md-table-row').length===2 && v.state.doc.toString().includes('正文')`),await doc())
        await key('z',MOD)
        check('相邻段落输入与分隔一步撤销',await doc()===source,await doc())
        await send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5})
        await send('Input.insertText',{text:'中文'})
        await sleep(100)
        check('相邻分隔行中文输入保留表格',await evaluate(`v.contentDOM.querySelectorAll('.cm-md-table-row').length===2 && v.state.doc.toString().includes('中文')`),await doc())
        await send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0})
        // 结束 CDP 组字会话后，下一夹具再恢复普通方向键导航。
        for(let wait=0;wait<30&&await evaluate('v.composing');wait++)await sleep(30)
      }
    },
    async cursorQuote() {
      const { verifyCursorQuote } = await import('./verify-cursor-quote.mjs')
      await verifyCursorQuote({ evaluate, send, key, setDoc, type, check, mainEval, ELECTRON })
    },
    async empty() {
      const original = '| A | B |\n|---|---|\n|   | `c|d` |\n'
      await setDoc(original)
      await clickCell(1, 0)
      await type('`')
      check('空格子反引号按整行保护邻格代码', await doc() === original.replace('|   |', '| \\` |'), await doc())
      await key('z', MOD)
      check('空格子整行保护一步撤销', await doc() === original, await doc())
    },
    async missing() {
      const original = '| A | B | C |\n|---|---|---|\n| a`b |\n'
      await setDoc(original)
      await clickCell(1, 1)
      await type('`c|d`')
      check('缺省格代码补齐格线并保护原格反引号', await doc() === original.replace('| a`b |', '| a\\`b | `c|d` |  |'), await doc())
      await key('z', MOD)
      check('缺省格补齐和保护一步撤销', await doc() === original, await doc())
    },
    async ime() {
      const original = '| A | B |\n|---|---|\n| x | `c|d` |\n'
      for (const [text, expected] of [['甲|乙', '甲\\|乙'], ['甲`', '甲\\`'], ['甲\\', '甲\\']]) {
        await setDoc(original)
        await select('x')
        await send('Input.imeSetComposition', { text: text.slice(0, 1), selectionStart: 1, selectionEnd: 1 })
        await sleep(60)
        await evaluate(`window.compositionNode = getSelection().anchorNode; undefined`)
        await send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
        await sleep(60)
        check(`组字 ${JSON.stringify(text)} 不重建输入节点`, await evaluate('compositionNode.isConnected && getSelection().anchorNode === compositionNode'))
        await send('Input.insertText', { text })
        await sleep(180)
        check(`输入法提交 ${JSON.stringify(text)} 保护格线和邻格代码`, await doc() === original.replace('| x |', `| ${expected}x |`), await doc())
        await key('z', MOD)
        check(`输入法提交 ${JSON.stringify(text)} 一步撤销`, await doc() === original, await doc())
      }
    },
    async imeLifecycle() {
      const original = '| A | B |\n|---|---|\n| x | y |\n'
      const compose = async text => {
        await sleep(40)
        await send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
        await send('Input.insertText', { text })
      }
      for (const next of ['Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '普通键', '连续组字']) {
        await setDoc(original)
        await select('x')
        await compose('甲|乙')
        check(`组字提交在 ${next} 前已保护格线`, await doc() === original.replace('x', '甲\\|乙x'), await doc())
        if (next === '连续组字') {
          await compose('丙|丁')
          check('连续组字分别保护且不遗留快照', await doc() === original.replace('x', '甲\\|乙丙\\|丁x'), await doc())
        } else if (next === '普通键') {
          await send('Input.insertText', { text: 'Z' })
          check('组字后立即普通输入留在同格', await doc() === original.replace('x', '甲\\|乙Zx'), await doc())
        } else {
          await key(next)
          check(`组字后立即 ${next} 保留提交并正常导航`, await doc() === original.replace('x', '甲\\|乙x') + (next === 'Enter' ? '|  |  |\n' : ''), await doc())
        }
      }
      await setDoc(original)
      await select('x')
      await sleep(40)
      await send('Input.imeSetComposition', { text: '取消', selectionStart: 2, selectionEnd: 2 })
      await send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
      check('取消组字保留原文字节', await doc() === original, await doc())
      await send('Input.insertText', { text: 'Z' })
      check('取消组字后下一次输入正常', await doc() === original.replace('x', 'Zx'), await doc())
      for (const mode of ['源码', '标签']) {
        await setDoc(original)
        await select('x')
        await sleep(40)
        await send('Input.imeSetComposition', { text: '甲|乙', selectionStart: 3, selectionEnd: 3 })
        await evaluate(`document.querySelector(${JSON.stringify(mode === '源码' ? '#source-toggle-btn' : '.tab-new-btn')}).click()`)
        if (mode === '源码') {
          check('组字期间切源码先保护当前文字', await evaluate(`document.getElementById('source-editor').value`) === original.replace('x', '甲\\|乙x'))
          await evaluate(`document.getElementById('source-toggle-btn').click()`)
        } else {
          for (let i = 0; i < 50 && await doc() !== ''; i++) await sleep(20)
          check('组字期间切标签不把文字带入新标签', await doc() === '')
          await evaluate(`document.querySelector('.tab-entry').click()`)
        }
        await sleep(100)
        check(`组字期间切${mode}往返保留原文`, await doc() === original.replace('x', '甲\\|乙x'), await doc())
        await select('x')
        await sleep(40)
        await send('Input.insertText', { text: 'Z' })
        check(`组字期间切${mode}后可继续输入`, await doc() === original.replace('x', '甲\\|乙Zx'), await doc())
      }
    },
    async imeWidgetLifecycle() {
      for (const [kind, original, column, expected] of [
        ['空格', '| A | B |\n|---|---|\n|   | y |\n', 0, '| A | B |\n|---|---|\n| 甲\\|乙 | y |\n'],
        ['缺省格', '| A | B |\n|---|---|\n| z |\n', 1, '| A | B |\n|---|---|\n| z | 甲\\|乙 |\n'],
      ]) for (const mode of ['源码', '标签']) {
        await setDoc(original)
        await clickCell(1, column)
        await send('Input.imeSetComposition', { text: '甲|乙', selectionStart: 3, selectionEnd: 3 })
        await evaluate(`document.querySelector(${JSON.stringify(mode === '源码' ? '#source-toggle-btn' : '.tab-new-btn')}).click()`)
        if (mode === '源码') {
          check(`${kind} 组字期间切源码包含当前文字`, await evaluate(`document.getElementById('source-editor').value`) === expected, await evaluate(`document.getElementById('source-editor').value`))
          await evaluate(`document.getElementById('source-toggle-btn').click()`)
        } else {
          for (let i = 0; i < 50 && await doc() !== ''; i++) await sleep(20)
          check(`${kind} 组字期间新标签保持空白`, await doc() === '')
          await evaluate(`document.querySelector('.tab-entry').click()`)
        }
        await sleep(100)
        check(`${kind} 组字期间切${mode}往返字节正确`, await doc() === expected, await doc())
      }
    },
    async imeLayout() {
      const original = '| A | B |\n|---|---|\n| 1 | label |\n'
      const digits = '1234567890'.repeat(14)
      await setDoc(original)
      const before = await evaluate(`[...v.contentDOM.querySelectorAll('.cm-md-table-header .cm-md-table-cell')].map(cell => cell.getBoundingClientRect().width)`)
      await select('1', 0, 1)
      await send('Input.imeSetComposition', { text: digits.slice(0, 20), selectionStart: 20, selectionEnd: 20 })
      await sleep(60)
      await evaluate('window.numberCompositionNode = getSelection().anchorNode; undefined')
      await send('Input.imeSetComposition', { text: digits, selectionStart: digits.length, selectionEnd: digits.length })
      await sleep(60)
      check('数字组字不重建输入节点', await evaluate('numberCompositionNode.isConnected && numberCompositionNode === getSelection().anchorNode'))
      await send('Input.insertText', { text: digits })
      await sleep(250)
      const layout = await evaluate(`(() => {const cell=v.contentDOM.querySelector('.cm-md-table-number');return {widths:[...v.contentDOM.querySelectorAll('.cm-md-table-header .cm-md-table-cell')].map(cell => cell.getBoundingClientRect().width),wrap:getComputedStyle(cell).whiteSpace,overflow:cell.scrollWidth-cell.clientWidth}})()`)
      check('无转义修正的输入法提交仍更新数字换行并保留列宽', layout.wrap !== 'nowrap' && layout.overflow <= 1 && before.every((width, i) => Math.abs(width - layout.widths[i]) <= 1), JSON.stringify({before,layout}))
      check('数字输入法提交只改当前格', await doc() === original.replace('| 1 |', `| ${digits} |`), await doc())
      await key('z', MOD)
      check('数字输入法提交一步撤销', await doc() === original, await doc())
    },
    async keys() {
      const original = '- | A | B |\n  |---|---|\n  | x | y |\n'
      for (const [name, modifiers, expected] of [['Tab', 0, 'B'], ['Tab', 8, 'A']]) {
        await setDoc(original)
        await select(modifiers ? 'B' : 'A')
        await key(name, modifiers)
        check(`列表表头 ${modifiers ? 'Shift+Tab' : 'Tab'} 由表格导航接管`, await doc() === original && await evaluate('v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)') === expected, await doc())
      }
      await setDoc(original)
      await select('A')
      await key('Enter')
      check('列表表头 Enter 在同列表格下一行', await doc() === original && await evaluate('v.state.selection.main.from') === original.indexOf('x'), await doc())
      await setDoc(original)
      await select('A', 1)
      await key('Enter', 8)
      check('列表表头 Shift+Enter 在格内换行', await doc() === original.replace('A', 'A<br>'), await doc())
      await setDoc(original)
      await select('A')
      await key('Enter', MOD)
      check('列表表头 Mod+Enter 增行且不增加列表项', (await doc()).split('\n').length === original.split('\n').length + 1 && (await doc()).startsWith('- | A | B |\n  |---|---|\n  |  |  |'), await doc())
      await setDoc('正文\n\n- 列表\n')
      await select('列表')
      await key('Enter')
      check('表格外 Enter 继续由列表处理', (await doc()).includes('\n- \n'), await doc())
    },
    async shift() {
      const original = '| A | B | C |\n|---|---|---|\n| x |   | z |\n'
      for (const direction of ['ArrowLeft', 'ArrowRight']) {
        await setDoc(original)
        await clickCell(1, 1)
        const anchor = await head()
        await key(direction, 8)
        check(`空格子 Shift+${direction} 保留锚点扩选`, await evaluate(`v.state.selection.main.anchor === ${anchor} && v.state.selection.main.head ${direction === 'ArrowLeft' ? '<' : '>'} ${anchor}`))
        check(`空格子 Shift+${direction} 不修改原文`, await doc() === original)
      }
    },
    async tsv() {
      const original = '| A | B |\n|---|---|\n' + '| a`b | old |\n'.repeat(160)
      await setDoc(original)
      await select('old', 0, 3)
      await evaluate(`window.rowScans = 0; window.originalIndexOf = Array.prototype.indexOf; Array.prototype.indexOf = function(value, ...rest) { if(value && typeof value === 'object' && ('cells' in value || ('insert' in value && 'from' in value))) rowScans += this.length; return originalIndexOf.call(this, value, ...rest) }`)
      try {
        await paste(Array.from({length:160}, () => '`c|d`\textra').join('\n'))
      } finally {
        await evaluate('Array.prototype.indexOf = originalIndexOf')
      }
      check('大批 TSV 扩列仍逐行保护反引号', (await doc()).split('\n').slice(2, -1).every(line => line === '| a\\`b | `c|d` | extra |'), (await doc()).slice(0, 200))
      check('TSV 和整行保护不反复线性查找行或编辑', await evaluate('rowScans') === 0, await evaluate('rowScans'))
      await key('z', MOD)
      check('大批 TSV 整体一步撤销', await doc() === original)
    },
    async paragraphIdentity() {
      let original = '# 多表正文编辑\n\n'
      for (let table = 0; table < 120; table++) {
        original += `第 ${table} 段正文。\n\n| A | B |\n|---|---|\n` + '| item | value |\n'.repeat(25) + '\n'
      }
      await setDoc(original)
      const settle = () => evaluate(`(async () => {
        v.requestMeasure(); v.coordsAtPos(v.state.selection.main.head);
        for (let i=0;i<3;i++) await new Promise(resolve=>requestAnimationFrame(resolve));
      })()`)
      for (const paragraph of ['第 60 段正文', '第 0 段正文']) {
        await select(paragraph, 2)
        await evaluate('v.dispatch({scrollIntoView:true})')
        await settle()
        for (const operation of ['打字', '退格']) {
          await evaluate(`window.unchangedTables=[...v.contentDOM.querySelectorAll('.cm-md-table-widget:has(.cm-md-table-row)')];window.tableStyles=[...v.dom.querySelectorAll('style')].map(style=>style.textContent)`)
          if (operation === '打字') await type('x')
          else await key('Backspace')
          await settle()
          const result = await evaluate(`({ visible:unchangedTables.length, retained:unchangedTables.filter(table=>table.isConnected).length, stylesUnchanged:JSON.stringify(tableStyles)===JSON.stringify([...v.dom.querySelectorAll('style')].map(style=>style.textContent)) })`)
          check(`${paragraph}${operation} 不重新挂载未编辑的表格`, result.visible > 0 && result.retained === result.visible, JSON.stringify(result))
          check(`${paragraph}${operation} 不重写未改变的列宽规则`, result.stylesUnchanged, JSON.stringify(result))
        }
      }
      check('多表正文真实输入和退格保持源码', await doc() === original)
      await type('x')
      await settle()
      await clickCell(1, 0, 0.5)
      const position = await head(), edited = await doc(), cell = edited.indexOf('item')
      check('正文插入后点击仍落在第一张表的实际格子', position >= cell && position <= cell + 4, String(position))
      await type('Z')
      check('稳定表格身份按当前源码位置输入', await doc() === edited.slice(0, position) + 'Z' + edited.slice(position))
    },
    async singleState() {
      await setDoc('| A | B |\n|---|---|\n| value | label |\n')
      await evaluate(`(() => {
        window.docStateBuilds = 0;
        v.dispatch({effects:v.scrollSnapshot().constructor.appendConfig.of(v.constructor.contentAttributes.compute(['doc'], () => { docStateBuilds++; return {} }))});
      })()`)
      for (const [name, removed, inserted] of [['格尾插入', 0, 'X'], ['格尾退格', 1, ''], ['格中删除', 1, ''], ['格内粘贴', 0, 'paste']]) {
        await setDoc('| A | B |\n|---|---|\n| value | label |\n')
        await select('value', name === '格中删除' ? 3 : 5)
        await evaluate('docStateBuilds = 0')
        await evaluate(`(() => {const h=v.state.selection.main.head;v.dispatch({changes:{from:h-${removed},to:h,insert:${JSON.stringify(inserted)}},selection:{anchor:h-${removed}+${inserted.length}},userEvent:${JSON.stringify(name === '格内粘贴' ? 'input.paste' : removed ? 'delete.backward' : 'input.type')}})})()`)
        check(`${name} 调整光标只构造一次文档状态`, await evaluate('docStateBuilds') === 1, String(await evaluate('docStateBuilds')))
      }
    },
    async incremental() {
      const original = '正文。\n\n| A | B |\n|---|---|\n' + '| item | value |\n'.repeat(600)
      for (const target of ['正文', 'A', 'item']) {
        await setDoc(original)
        await select(target, 1)
        await evaluate(`(() => {
          window.tableDecoRefs = v.state.facet(v.constructor.outerDecorations).map(set => typeof set === 'function' ? set(v) : set).filter(set => set.between).flatMap(set => {
            const refs = []; set.between(v.state.doc.length - 30, v.state.doc.length - 1, (_from,_to,deco) => { if(deco.spec.class?.includes('cm-md-table')) refs.push(deco) }); return refs;
          });
          window.slicedCharacters = 0; window.tableSlicedCharacters = 0; window.textPrototype = Object.getPrototypeOf(v.state.doc); window.originalSlice = textPrototype.sliceString;
          textPrototype.sliceString = function(from, to = this.length, ...args) { slicedCharacters += to - from; if(/readRow|hiddenEscapes|cellEditContext|tableDecorations|readTable/.test(new Error().stack)) tableSlicedCharacters += to - from; return originalSlice.call(this, from, to, ...args) };
        })()`)
        try {
          await evaluate(`(() => {const h=v.state.selection.main.head;v.dispatch({changes:{from:h,insert:'X'},selection:{anchor:h+1},userEvent:'input.type'})})()`)
        } finally { await evaluate('textPrototype.sliceString = originalSlice') }
        const refs = await evaluate(`(() => {const refs = v.state.facet(v.constructor.outerDecorations).map(set => typeof set === 'function' ? set(v) : set).filter(set => set.between).flatMap(set => {const found=[];set.between(v.state.doc.length-30,v.state.doc.length-1,(_from,_to,deco)=>{if(deco.spec.class?.includes('cm-md-table'))found.push(deco)});return found});return {total:tableDecoRefs.length,reused:tableDecoRefs.filter(deco=>refs.includes(deco)).length,sliced:slicedCharacters, tableSliced:tableSlicedCharacters}})()`)
        check(`${target} 编辑复用未改行装饰`, refs.total > 0 && refs.reused === refs.total, JSON.stringify(refs))
        check(`${target} 编辑不读取整张表的所有格子`, refs.tableSliced < original.length / 3, JSON.stringify(refs))
      }
    },
    async numericIncremental() {
      const original = '| A | B |\n|---|---|\n' + '| 123 | label |\n'.repeat(600)
      await setDoc(original)
      await select('123', 3)
      await evaluate(`v.requestMeasure();v.coordsAtPos(v.state.selection.main.head)`)
      const widths = await evaluate(`[...v.contentDOM.querySelectorAll('.cm-md-table-header .cm-md-table-cell')].map(cell=>cell.getBoundingClientRect().width)`)
      await evaluate(`window.numericRead = 0; window.numericTextPrototype = Object.getPrototypeOf(v.state.doc); window.numericSlice = numericTextPrototype.sliceString;
        numericTextPrototype.sliceString = function(from,to=this.length,...args) { if(/readRow|readTable|tableLayoutSnapshot/.test(new Error().stack)) numericRead+=to-from;return numericSlice.call(this,from,to,...args) }`)
      try {
        await send('Input.insertText', { text: '1' })
        await evaluate(`v.requestMeasure();v.coordsAtPos(v.state.selection.main.head)`)
      } finally { await evaluate('numericTextPrototype.sliceString = numericSlice') }
      console.log('数字增量读取字符数：' + await evaluate('numericRead'))
      check('大表数字编辑的布局复核不读取整表', await evaluate('numericRead') < original.length / 3, String(await evaluate('numericRead')))
      await send('Input.insertText', { text: '1234567890'.repeat(12) })
      await evaluate(`v.requestMeasure();v.coordsAtPos(v.state.selection.main.head)`)
      const geometry = await evaluate(`(() => {const cell=v.contentDOM.querySelector('.cm-md-table-number');return {widths:[...v.contentDOM.querySelectorAll('.cm-md-table-header .cm-md-table-cell')].map(cell=>cell.getBoundingClientRect().width),overflow:cell.scrollWidth-cell.clientWidth,wrap:getComputedStyle(cell).whiteSpace}})()`)
      check('增量数字超宽时放开折行且保留列宽', geometry.wrap !== 'nowrap' && geometry.overflow <= 1 && widths.every((width,index)=>Math.abs(width-geometry.widths[index])<=1),JSON.stringify({widths,geometry}))
    },
    async reset() {
      await setDoc('| A | B |\n|---|---|\n| x | y |\n')
      await setDoc('正文\n')
      check('整篇替换后没有旧表格行装饰', await evaluate(`v.contentDOM.querySelectorAll('.cm-md-table-row').length`) === 0)
      await setDoc('| C | D |\n|---|---|\n| new | table |\n')
      check('整篇替换后每行均在当前表格 wrapper 内', await evaluate(`[...v.contentDOM.querySelectorAll('.cm-md-table-row')].every(row => row.closest('.cm-md-table-widget'))`))
    },
    async escapeColors() {
      const source = '正文 a\\|b\n\n| A | B |\n|---|---|\n| a\\|b | text |\n\n```js\nconst s = "a\\nb"\n```\n'
      for (const theme of ['elegant','bear','custom:template.css']) {
        await setTheme(theme, theme.startsWith('custom:') ? readFileSync(join(ROOT,'themes/template.css'),'utf8') : undefined)
        await setDoc(source)
        for (let attempt = 0; attempt < 40 && !await evaluate(`!![...v.contentDOM.querySelectorAll('.cm-md-codeblock')].find(line => line.textContent.includes('const s'))?.querySelector('span')`); attempt++) await sleep(50)
        check(`${theme} 正文与表格转义竖线使用正文色`, await evaluate(`(() => {
          const walker=document.createTreeWalker(v.contentDOM,NodeFilter.SHOW_TEXT);let node,seen=0;
          while(node=walker.nextNode()) {
            if(!node.textContent.includes('|')||node.parentElement.closest('.cm-md-codeblock,.cm-md-marker,.cm-md-table-marker'))continue;
            const range=document.createRange();range.selectNodeContents(node);
            if(!range.getBoundingClientRect().width)continue;
            seen++;if(getComputedStyle(node.parentElement).color!==getComputedStyle(v.contentDOM).color)return false;
          }
          return seen>=2;
        })()`))
        const codeColors = await evaluate(`(() => {
          const code=Array.from(v.contentDOM.querySelectorAll('.cm-md-codeblock')).find(line=>line.textContent.includes('const s'));
          const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);let node,escape;
          while(node=walker.nextNode())if(node.textContent.includes('\\\\n'))escape=node.parentElement;
          if(!escape)return {found:false,html:code?.outerHTML};
          const sample=document.createElement('span');sample.style.color=getComputedStyle(code).getPropertyValue('--code-string');document.body.appendChild(sample);
          const expected=getComputedStyle(sample).color;sample.remove();
          return {found:true,actual:getComputedStyle(escape).color,expected,html:code.outerHTML};
        })()`);
        check(`${theme} 代码块字符串转义仍保留代码语法色`, codeColors.found && codeColors.actual===codeColors.expected, JSON.stringify(codeColors))
      }
    },
    async pdf() {
      const source = '# 分页表格\n\n| 行号 | 内容 | 金额 |\n| --- | --- | ---: |\n' +
        Array.from({length:60}, (_, index) => {
          const id = String(index + 1).padStart(3, '0')
          return `| R${id} | BEGIN${id} ${'长行内容 mixed words '.repeat((index + 1) % 10 === 0 ? 17 : 1)}END${id} | ${index + 1}.45 |`
        }).join('\n') + '\n\nPDFEND060\n'
      await setTheme('writer')
      await setDoc(source)
      const out = join(dir, 'table-rows.pdf')
      await mainEval(`(() => {
        const {BrowserWindow,dialog}=${ELECTRON};
        globalThis.originalPDFSave=dialog.showSaveDialog;
        globalThis.originalPDFShow=BrowserWindow.prototype.show;
        globalThis.originalPDFFocus=BrowserWindow.prototype.focus;
        dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(out)}});
        BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
      })()`)
      try {
        await sendToWindow('menu-export-pdf')
        for(let i=0;i<300&&!existsSync(out);i++) await sleep(100)
        check('真实菜单 PDF 导出成功', existsSync(out))
        const pdf = readFileSync(out).toString('latin1')
        check('长表格实际导出多页 PDF', (pdf.match(/\/Type\s*\/Page(?!s)/g) ?? []).length > 1)
        // 字体子集把文本编码成字形号，不能在 PDF 二进制中直接查行标记。
        // 本机有 Poppler 时逐页提取，证明同一行的首尾没有落到不同页。
        const extracted = spawnSync('pdftotext', ['-layout', out, '-'], {encoding:'utf8'})
        if (extracted.error?.code === 'ENOENT') {
          console.log('SKIP PDF 逐页行标记核对：未安装 pdftotext；保留真实 PDF 产物与打印规则检查')
        } else {
          check('PDF 文本可解析', extracted.status === 0, extracted.stderr)
          const pages = extracted.stdout.split('\f')
          if (pages.at(-1) === '') pages.pop()
          check('PDF 每页有正文且文末标记在最后一页', pages.every(page => page.trim()) && pages.at(-1).includes('PDFEND060'))
          const failures = []
          for(let row=1;row<=60;row++) {
            const id = String(row).padStart(3,'0')
            const begin = pages.flatMap((page,index)=>page.includes('BEGIN'+id)?[index]:[])
            const end = pages.flatMap((page,index)=>page.includes('END'+id)?[index]:[])
            if(begin.length!==1||end.length!==1||begin[0]!==end[0]) failures.push({row,begin,end})
          }
          check('真实 PDF 六十行首尾完整且不跨页', failures.length===0, JSON.stringify(failures))
          check('PDF 短编号完整不拆行', Array.from({length:60}, (_,i)=>'R'+String(i+1).padStart(3,'0')).every(id=>extracted.stdout.includes(id)))
          check('跨页表格逐页重复表头且表头不孤立', pages.every(page => !/BEGIN\d{3}/.test(page) || /行号/.test(page.replace(/\s/g,'')) && /内容/.test(page.replace(/\s/g,''))))
        }
        const screenRules = await evaluate(`document.querySelector('.cm-editor > style')?.textContent`)
        await send('Emulation.setEmulatedMedia', {media:'print'})
        await mainEval(`${ELECTRON}.BrowserWindow.getAllWindows()[0].setContentSize(700,800)`)
        await sleep(150)
        check('打印媒体重排不改写屏幕列宽规则', await evaluate(`document.querySelector('.cm-editor > style')?.textContent`) === screenRules)
        check('打印排版把表格行作为不可拆分单元', await evaluate(`(() => {const rows=Array.from(document.querySelectorAll('.cm-md-table-row'));return rows.length>1&&rows.every(row=>getComputedStyle(row).breakInside==='avoid')})()`))
        check('PDF 导出不修改原文', await doc()===source)
        check('PDF 不创建打印副本', await evaluate(`!document.querySelector('.colamd-print-copy')`))
      } finally {
        await send('Emulation.setEmulatedMedia', {media:''})
        await mainEval(`${ELECTRON}.BrowserWindow.getAllWindows()[0].setContentSize(1200,900)`)
        await mainEval(`(() => {const {BrowserWindow,dialog}=${ELECTRON};dialog.showSaveDialog=originalPDFSave;BrowserWindow.prototype.show=originalPDFShow;BrowserWindow.prototype.focus=originalPDFFocus})()`)
      }
    },
    async image() {
      await setTheme('elegant')
      await setDoc('| 数字 | 说明 |\n|---|---|\n| 123456789012345678901234567890123456789012345678901234567890 | 短 |\n')
      await mainEval(`(() => {
        const {BrowserWindow, dialog} = ${ELECTRON}; const fs = process.getBuiltinModule('fs');
        globalThis.tableImageProbe = null;
        globalThis.originalTableLoad = BrowserWindow.prototype.loadFile;
        globalThis.originalTableSave = dialog.showSaveDialog;
        globalThis.originalTableMessage = dialog.showMessageBox;
        globalThis.originalTableShow = BrowserWindow.prototype.show;
        globalThis.originalTableFocus = BrowserWindow.prototype.focus;
        BrowserWindow.prototype.show = function() {}; BrowserWindow.prototype.focus = function() {};
        dialog.showSaveDialog = async () => ({canceled:false,filePath:${JSON.stringify(join(dir, 'table-mobile.png'))}});
        dialog.showMessageBox = async () => ({response:0});
        BrowserWindow.prototype.loadFile = async function(path, ...args) {
          const result = await originalTableLoad.call(this, path, ...args);
          if(path.includes('colamd-image-export-')) {
            globalThis.tableImageHTML = fs.readFileSync(path, 'utf8');
            globalThis.tableImageProbe = await this.webContents.executeJavaScript(\`(() => {
              const content = document.querySelector('.cm-content'), table = content.querySelector('.cm-md-table-widget');
              const rules = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.selectorText?.includes('[data-table-layout=') && rule.style.width);
              return { rules: rules.length, matched: rules.filter(rule => document.querySelector(rule.selectorText)).length,
                right:table.getBoundingClientRect().right, limit:content.getBoundingClientRect().right,
                numbers:[...document.querySelectorAll('.cm-md-table-number')].map(cell => getComputedStyle(cell).whiteSpace) };
            })()\`);
          }
          return result;
        };
      })()`)
      try {
        await sendToWindow('menu-export-image', 'mobile')
        let probe
        for (let i=0;i<150;i++) { probe = await mainEval('globalThis.tableImageProbe'); if(probe) break; await sleep(100) }
        check('真实图片导出 HTML 的列宽规则命中作用域', probe?.rules > 0 && probe.matched === probe.rules, JSON.stringify(probe))
        check('手机图片导出长数字不超出正文右边界', probe.right <= probe.limit + 1 && probe.numbers.every(value => value === 'normal'), JSON.stringify(probe))
        for (let i=0;i<150;i++) { if(await mainEval(`${ELECTRON}.BrowserWindow.getAllWindows().length === 1`)) break; await sleep(100) }
      } finally {
        await mainEval(`(() => { const {BrowserWindow,dialog}=${ELECTRON}; BrowserWindow.prototype.loadFile=originalTableLoad; BrowserWindow.prototype.show=originalTableShow; BrowserWindow.prototype.focus=originalTableFocus; dialog.showSaveDialog=originalTableSave; dialog.showMessageBox=originalTableMessage })()`)
      }
    },
  }
  for (const [name, run] of Object.entries(regressions)) if (!regression || name === regression) { await run(); check(`${name} 回归没有运行时异常`, errors.length === 0, JSON.stringify(errors)) }
  if (regression) {
    check('运行时没有异常', errors.length === 0, JSON.stringify(errors))
    console.log(`\n${passed} 项表格回归检查通过`)
    process.exitCode = 0
  } else {
  await setDoc(fixture)
  check('打开表格不修改原文', await doc() === fixture, JSON.stringify({doc:await doc(), errors}))
  check('表格按原有对齐方式显示', await evaluate(`Array.from(document.querySelectorAll('.cm-md-table-header .cm-md-table-cell')).map(c=>getComputedStyle(c).textAlign).join(',')`) === 'left,center,right')
  const selectionFixture = '段落。\n\n| 名称 | 数量 | 说明 |\n| :--- | ---: | :--- |\n| 苹果 | 12 | **加粗** 与 `代码` |\n|  | 3 | 空格子 |\n\n> 引用开头\n>\n> | 日期 | 事项 |\n> | --- | --- |\n> | 周一 | 整理 |\n>\n> 引用结尾\n\n结尾。\n'
  const themes = ['light', 'dark', 'elegant', 'sepia', 'notion', 'bear', 'writer', 'solarized-dark', 'nord', 'gruvbox', 'dracula', 'midnight']
  await setDoc(selectionFixture)
  for (const [theme, css] of [...themes.map(theme => [theme]),
    ['custom:large', '.cm-content { font-family: Georgia, serif; font-size: 25px; line-height: 1.8; }'],
    ['custom:small', '.cm-content { font-family: monospace; font-size: 15px; line-height: 1.5; }']]) {
    await setTheme(theme, css)
    await evaluate(`v.dispatch({selection:{anchor:${selectionFixture.indexOf('日期')},head:${selectionFixture.indexOf('整理') + 2}}}); v.focus()`)
    await sleep(80)
    const selectionBounds = await evaluate(`(() => {
    const table = document.querySelector('.cm-md-table-widget.cm-md-blockquote:has(.cm-md-table-row)')
    const first = table.querySelector('.cm-md-table-header').getBoundingClientRect()
    const last = table.querySelector('.cm-md-table-last').getBoundingClientRect()
    const pieces = [...document.querySelectorAll('.cm-selectionBackground')].map(piece => piece.getBoundingClientRect())
    return { top: Math.min(...pieces.map(piece => piece.top)), first: first.top,
      bottom: Math.max(...pieces.map(piece => piece.bottom)), last: last.bottom, count: pieces.length }
  })()`)
    check(`${theme} 切换后引用表格选区保持在首末行内`, selectionBounds.count > 0 && selectionBounds.top >= selectionBounds.first - 1 && selectionBounds.bottom <= selectionBounds.last + 1, JSON.stringify(selectionBounds))
  }
  check('绘制表格选区保持原文', await doc() === selectionFixture)
  await setTheme('elegant')
  await setDoc(fixture)
  const geometry = await evaluate(`Array.from(document.querySelectorAll('.cm-md-table-cell')).map(c=>({x:c.getBoundingClientRect().x,w:c.getBoundingClientRect().width}))`)
  const drag = await evaluate(`(() => {const row=document.querySelector('.cm-md-table-header').getBoundingClientRect();return {x1:row.left+6,x2:row.right-6,y:row.top+row.height/2}})()`)
  for (const legacy of [false, true]) {
    if (legacy) await evaluate(`window.caretMethod = document.caretPositionFromPoint; document.caretPositionFromPoint = undefined`)
    await send('Input.dispatchMouseEvent', {type:'mousePressed',x:drag.x1,y:drag.y,button:'left',clickCount:1})
    for (let i=1;i<=8;i++) await send('Input.dispatchMouseEvent', {type:'mouseMoved',x:drag.x1+(drag.x2-drag.x1)*i/8,y:drag.y,button:'left',buttons:1})
    await send('Input.dispatchMouseEvent', {type:'mouseReleased',x:drag.x2,y:drag.y,button:'left',clickCount:1})
    check(legacy ? '旧版光标 API 仍支持跨格拖选' : '从留白拖选可以跨过多个单元格', await evaluate(`getSelection().toString().includes('名称') && getSelection().toString().includes('数量')`), await evaluate('getSelection().toString()'))
    if (legacy) await evaluate(`document.caretPositionFromPoint = window.caretMethod`)
  }
  const wordBox = await evaluate(`(() => {const r=document.querySelector('.cm-md-table-header .cm-md-table-cell').getBoundingClientRect();return {x:r.left+24,y:r.top+18}})()`)
  for (const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent', {type,...wordBox,button:'left',clickCount:2})
  check('双击单元格可以选词', await evaluate(`v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)`) === '名称')
  check('拖选和选词保持原文', await doc() === fixture)
  await clickCell(1, 0)
  check('点击后保持表格形状', await evaluate(`document.querySelectorAll('.cm-md-table-row').length`) === 4)
  await type('新')
  check('点击哪一格就编辑哪一格', (await doc()).includes('| 新苹果 | **加粗**和 `代码` | 123 |'), await doc())
  await key('z', MOD)
  check('单元格编辑可撤销', await doc() === fixture)
  await key('z', MOD | 8)
  check('单元格编辑可重做', (await doc()).includes('新苹果'))
  await key('z', MOD)
  const afterClick = await evaluate(`Array.from(document.querySelectorAll('.cm-md-table-cell')).map(c=>({x:c.getBoundingClientRect().x,w:c.getBoundingClientRect().width}))`)
  check('点击和编辑不引起列宽跳动', JSON.stringify(geometry) === JSON.stringify(afterClick))

  await select('苹果', 2)
  await key('Tab')
  check('Tab 选中下一格内容', await evaluate('v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)') === '**加粗**和 `代码`')
  await key('Tab', 8)
  check('Shift+Tab 返回上一格', await evaluate('v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)') === '苹果')
  await select('苹果', 2)
  await key('ArrowRight')
  check('右方向键跨过分隔符', await evaluate('v.state.selection.main.head') === fixture.indexOf('**加粗**'))
  await key('ArrowLeft')
  check('左方向键返回上一格末尾', await evaluate('v.state.selection.main.head') === fixture.indexOf('苹果') + 2)
  await select('123', 1)
  await key('ArrowDown')
  check('下方向键保持当前列', await evaluate('v.state.selection.main.head') === fixture.indexOf('|| 空格子 | |') + '|| 空格子 | |'.length - 1, await evaluate('v.state.selection.main.head'))
  await key('ArrowUp')
  const up = await evaluate('v.state.selection.main.head')
  check('上方向键返回原来的列', up >= fixture.indexOf('123') && up <= fixture.indexOf('123') + 3, up)
  await select('苹果')
  await key('Backspace')
  await select('苹果', 2)
  await key('Delete')
  check('单元格边界删除不破坏表格', await doc() === fixture)

  await select('空格子')
  await key('Enter', MOD)
  check('快捷键在当前行下方新增一行', (await doc()).includes('|| 空格子 | |\n|  |  |  |\n| 缺省 |'))
  await key('z', MOD)
  check('新增一行可一步撤销', await doc() === fixture)
  await select('空格子')
  await key('Enter', 8)
  check('Shift+Enter 在单元格中换行', (await doc()).includes('<br>空格子'))
  check('HTML 导出保留单元格换行', (await exportHTML()).includes('<br>空格子'))
  await key('z', MOD)

  await clickCell(2, 0)
  await type('空白')
  check('紧邻竖线的空单元格可以输入', (await doc()).includes('|空白| 空格子 | |'))
  await key('z', MOD)
  await clickCell(3, 2)
  check('点击缺省单元格不补写原文', await doc() === fixture)
  await type('补全')
  check('缺省单元格第一次输入才补齐', (await doc()).includes('| 缺省 |  | 补全 |'))
  await key('z', MOD)
  check('补齐单元格可一步撤销', await doc() === fixture)

  for (const [name, row, column] of [['空单元格', 2, 0], ['缺省单元格', 3, 2]]) {
    await clickCell(row, column)
    await send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 }); await sleep(60)
    await send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 }); await sleep(60)
    await send('Input.insertText', { text: '中文' }); await sleep(100)
    const value = await doc()
    check(`${name}支持中文组合输入`, (name === '空单元格' ? value.includes('|中文| 空格子 | |') : value.includes('| 缺省 |  | 中文 |')) && !value.includes('zhong'), value)
    await key('z', MOD)
    check(`${name}中文输入一步撤销`, await doc() === fixture)
  }

  await clickCell(3, 2)
  await send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 }); await sleep(60)
  await send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); await sleep(100)
  check('取消缺省格子的输入不改写原文', await doc() === fixture)
  await select('123')
  await key('Backspace', 1)
  check('按词删除不跨入上一格', await doc() === fixture, await doc())
  await select('123', 3)
  await key('Backspace', MOD)
  check('删到行首只清空当前格', (await doc()).includes('| 苹果 | **加粗**和 `代码` |  |'), await doc())
  await key('z', MOD)
  await select('苹果', 2)
  for (const text of [' ', 'test', ' ', 'word']) await type(text)
  check('连续输入空格和单词不丢字', (await doc()).includes('苹果 test word'), await doc())
  await key('z', MOD)
  await clickCell(3, 2)
  await key('Tab')
  check('末格 Tab 增行后由新行首格的临时输入接住', await evaluate(`document.activeElement.classList.contains('cm-md-table-input') && document.activeElement.closest('.cm-md-table-row').dataset.tableRow === '4' && document.activeElement.closest('.cm-md-table-cell').dataset.column === '0'`))
  await key('z', MOD)
  check('末格 Tab 增行可一步撤销', await doc() === fixture)
  await clickCell(3, 2)
  await key('Tab')
  await type('末尾')
  check('末格按 Tab 新增行并可继续输入', (await doc()).includes('| 末尾 |  |  |'), await doc())
  await key('Tab')
  await type('中格')
  await key('Tab')
  await type('末格')
  check('Tab 依次填满新行各格且不额外增行', (await doc()).includes('| 末尾 | 中格 | 末格 |') && (await doc()).split('\n').length === fixture.split('\n').length + 1, await doc())
  const filledRow = await doc()
  await key('Tab')
  await type('下一行')
  check('新行末格再次 Tab 才增下一行并落在首格', (await doc()).includes('| 末尾 | 中格 | 末格 |\n| 下一行 |  |  |') && (await doc()).split('\n').length === fixture.split('\n').length + 2, await doc())
  await key('z', MOD)
  await key('z', MOD)
  check('下一次增行和输入可分别撤销', await doc() === filledRow)
  for (let i = 0; i < 4; i++) await key('z', MOD)
  check('末尾增行和编辑可撤销', await doc() === fixture)
  await clickCell(3, 2)
  await key('Tab')
  await send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 }); await sleep(60)
  await send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 }); await sleep(60)
  await type('中文'); await sleep(100)
  check('Tab 新增行首格支持中文组合输入', (await doc()).includes('| 中文 |  |  |') && !(await doc()).includes('zhong'), await doc())
  await key('z', MOD)
  check('新行首格中文输入可一步撤销', (await doc()).includes('|  |  |  |') && !(await doc()).includes('中文'), await doc())
  await key('z', MOD)
  check('中文输入撤销后增行仍可一步撤销', await doc() === fixture)
  await select('缺省')
  await key('Tab')
  await key('Enter')
  await type('同列')
  check('末行 Enter 增行后仍保持当前列', (await doc()).includes('|  | 同列 |  |'), await doc())
  await key('z', MOD)
  await key('z', MOD)
  check('Enter 增行和输入可分别撤销', await doc() === fixture)

  for (const [name, prefix, source] of [
    ['引用', '> ', '> | A | B | C |\n> |---|---|---|\n> | x | y | z |\n'],
    ['无序列表', '  ', '- | A | B | C |\n  |---|---|---|\n  | x | y | z |\n'],
    ['有序列表', '   ', '1. | A | B | C |\n   |---|---|---|\n   | x | y | z |\n'],
    ['引用内列表', '>   ', '> - | A | B | C |\n>   |---|---|---|\n>   | x | y | z |\n'],
  ]) {
    await setDoc(source)
    await clickCell(1, 2)
    await key('Tab')
    await type('首格')
    await key('Tab')
    await type('中格')
    await key('Tab')
    await type('末格')
    check(`${name}表格末格 Tab 后依次填完新行且保留前缀`, await doc() === source.trimEnd() + `\n${prefix}| 首格 | 中格 | 末格 |\n`, await doc())
    for (let i = 0; i < 3; i++) await key('z', MOD)
    check(`${name}表格输入撤销后只留下新增空行`, await doc() === source.trimEnd() + `\n${prefix}|  |  |  |\n`, await doc())
    await key('z', MOD)
    check(`${name}表格 Tab 增行可一步撤销`, await doc() === source)
    for (const [action, modifiers, above] of [['Enter', 0, false], ['⌘Enter', MOD, false], ['⌘⇧Enter', MOD | 8, true]]) {
      await select('y')
      await key('Enter', modifiers)
      await type('同列')
      const row = `${prefix}|  | 同列 |  |\n`
      const expected = above ? source.replace(`${prefix}| x | y | z |\n`, row + `${prefix}| x | y | z |\n`) : source.trimEnd() + '\n' + row
      check(`${name}表格 ${action} 插行保持当前列与前缀`, await doc() === expected, await doc())
      await key('z', MOD)
      await key('z', MOD)
      check(`${name}表格 ${action} 插行和输入可分别撤销`, await doc() === source)
    }
  }

  const emptyCases = '| 姓名 | 城市 | 邮箱 | 备注 |\n|---|---|---|---|\n|  | 香港 |  | 等待 |\n||上海|||\n| 缺省 |\n'
  for (const theme of themes) {
    await setDoc(emptyCases)
    await setTheme(theme)
    check(`${theme} 空格子没有嵌套单元格`, await evaluate(`document.querySelectorAll('.cm-md-table-row').length === 4 && document.querySelectorAll('.cm-md-table-cell').length === 16 && !document.querySelector('.cm-md-table-cell .cm-md-table-cell')`))
    for (const [row, column] of [[1, 0], [2, 2], [3, 3]]) {
      await clickCell(row, column)
      check(`${theme} 第 ${row} 行第 ${column} 格可以显示输入光标`, await evaluate(`(() => {
        const input = document.activeElement
        const range = getSelection().getRangeAt(0)
        const rect = input.getBoundingClientRect()
        const cursor = getComputedStyle(input).caretColor
        return input.classList.contains('cm-md-table-input') && input.isContentEditable && range.startContainer === input && rect.width > 0 && rect.height > 0 && cursor !== 'transparent' && getComputedStyle(document.querySelector('.cm-cursorLayer')).display === 'none'
      })()`))
    }
    check(`${theme} 空行高度与普通行一致`, await evaluate(`(() => { const rows = document.querySelectorAll('.cm-md-table-row'); return Math.abs(rows[1].offsetHeight - rows[2].offsetHeight) < 2 && Math.abs(rows[1].offsetHeight - rows[3].offsetHeight) < 2 })()`))
    check(`${theme} 点击空格子保持原文`, await doc() === emptyCases)
    // 选区层在 z-index -2：表头底色画在行上会把它盖住，只能画在更低的伪元素上
    check(`${theme} 表头底色不盖住选区`, await evaluate(`(() => {
      const header = document.querySelector('.cm-md-table-header')
      const layer = getComputedStyle(header, '::after')
      const selection = getComputedStyle(document.querySelector('.cm-selectionLayer'))
      return getComputedStyle(header).backgroundColor === 'rgba(0, 0, 0, 0)' && Number(layer.zIndex) < Number(selection.zIndex) && layer.backgroundColor !== 'rgba(0, 0, 0, 0)'
    })()`))
  }
  await setTheme('elegant')
  await clickCell(2, 2)
  await key('ArrowRight')
  check('空格子内右方向键进入相邻空格', await evaluate(`document.activeElement.closest('.cm-md-table-cell').dataset.column === '3'`))
  await key('ArrowUp')
  check('空格子内上方向键进入上一行同列', await evaluate('v.state.selection.main.head') >= emptyCases.indexOf('等待') && await evaluate('v.state.selection.main.head') <= emptyCases.indexOf('等待') + 2)
  await clickCell(2, 2)
  await key('Enter', 8)
  check('空格子内 Shift+Enter 插入格内换行', (await doc()).includes('||上海|<br>||'), await doc())
  await key('z', MOD)
  check('空格子换行可撤销', await doc() === emptyCases)
  // 点击和方向键之外的路径（删空、撤销、恢复状态、程序化选区）把光标带进空格子时，
  // 同样要由那一格的输入框接住，否则光标撑满整格、打的字落进下一行。
  const emptyFocus = (row, column) => evaluate(`(async () => {
    for (let i = 0; i < 20; i++) {
      const input = document.activeElement
      if (input.classList.contains('cm-md-table-input') && input.closest('.cm-md-table-row').dataset.tableRow === '${row}' && input.closest('.cm-md-table-cell').dataset.column === '${column}' && getComputedStyle(document.querySelector('.cm-cursorLayer')).display === 'none') return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)
  const undoTo = async text => { for (let i = 0; i < 6 && await doc() !== text; i++) await key('z', MOD) }
  await select('等待', 2)
  await key('Backspace')
  await key('Backspace')
  check('删空格子后由格内输入框接住', await emptyFocus(1, 3), await evaluate('document.activeElement.className'))
  await type('甲')
  check('删空格子后输入留在原格', (await doc()).split('\n')[2].replace(/\s/g, '') === '||香港||甲|', await doc())
  await undoTo(emptyCases)
  check('删空格子与输入可撤销', await doc() === emptyCases)
  await clickCell(1, 0)
  await type('戊')
  await key('z', MOD)
  check('撤销回到空格子由格内输入框接住', await doc() === emptyCases && await emptyFocus(1, 0), await doc())
  await clickCell(1, 0)
  await type(' ')
  await type('乙')
  check('空格子先输入空格再输入文字仍在本格', (await doc()).split('\n')[2].replace(/\s/g, '') === '|乙|香港||等待|', await doc())
  await undoTo(emptyCases)
  await clickCell(2, 2)
  await evaluate(`(() => { const state = v.state; v.setState(state); v.focus() })()`)
  check('恢复编辑状态后由空格子输入框接住', await emptyFocus(2, 2))
  await type('丙')
  check('恢复编辑状态后输入留在原格', (await doc()).includes('||上海|丙||'), await doc())
  await undoTo(emptyCases)
  check('恢复状态后的输入可撤销', await doc() === emptyCases)
  await evaluate(`v.dispatch({ selection: { anchor: ${emptyCases.length - 1} } }); v.focus()`)
  check('行尾竖线之后的位置落在第一个缺省格', await emptyFocus(3, 1))
  await type('丁')
  check('缺省格输入补齐整行', (await doc()).endsWith('| 缺省 | 丁 |  |  |\n'), await doc())
  await undoTo(emptyCases)
  await clickCell(1, 2)
  check('空格子的光标坐标是一行高而不是整格', await evaluate(`(() => {
    const caret = v.coordsAtPos(v.state.selection.main.head, v.state.selection.main.assoc || 1), input = document.activeElement.getBoundingClientRect(), cell = document.activeElement.closest('.cm-md-table-cell').getBoundingClientRect()
    return caret.bottom - caret.top <= input.height + 1 && caret.left >= cell.left && caret.left <= cell.right
  })()`))
  await key('a', MOD)
  check('空格子内全选仍选中全文', await evaluate(`v.state.selection.main.from === 0 && v.state.selection.main.to === v.state.doc.length && document.activeElement === v.contentDOM`))
  const layoutCases = '正文。\n\n## 标题\n\n| 场景 | 示例 | 说明 |\n|---|---|---|\n| 换行 | 第一行<br>第二行<br>第三行 | 三行对齐 |\n| 长英文 | document_export_configuration_preview | 自动折行 |\n'
  await setDoc(layoutCases)
  check('换行的三行首字对齐且长英文没有额外空行', await evaluate(`(() => {
    const first = word => { const walker = document.createTreeWalker(v.contentDOM, NodeFilter.SHOW_TEXT); let node; while(node = walker.nextNode()) { const at = node.textContent.indexOf(word); if(at < 0) continue; const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 1); return { rect:range.getBoundingClientRect(), cell:node.parentElement.closest('.cm-md-table-cell') } } }
    const lines = ['第一行', '第二行', '第三行'].map(first)
    const english = first('document_export')
    return Math.max(...lines.map(line => line.rect.left)) - Math.min(...lines.map(line => line.rect.left)) < 1 && english.rect.top - english.cell.getBoundingClientRect().top - parseFloat(getComputedStyle(english.cell).paddingTop) < parseFloat(getComputedStyle(english.cell).lineHeight) / 2
  })()`))
  const compact = '|名称|值|\n|---|---|\n|宽度|1280|\n'
  await setDoc(compact)
  const endPoint = await evaluate(`(() => { const range = document.createRange(); range.selectNodeContents(document.querySelectorAll('.cm-md-table-row')[1].querySelector('.cm-md-table-cell')); const r = range.getBoundingClientRect(); return {x:r.right + 2,y:r.top + r.height / 2} })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', {type, ...endPoint, button:'left', clickCount:1})
  await sleep(80)
  check('紧凑表格末字后的光标仍在当前格', await evaluate(`(() => { const cell = document.querySelectorAll('.cm-md-table-row')[1].querySelector('.cm-md-table-cell').getBoundingClientRect(); const caret = document.querySelector('.cm-cursor').getBoundingClientRect(); return v.state.selection.main.head === ${compact.indexOf('宽度') + 2} && caret.left >= cell.left && caret.right <= cell.right && caret.top >= cell.top && caret.bottom <= cell.bottom })()`))
  await type('改')
  check('紧凑表格末字后输入仍属于当前格', await doc() === compact.replace('宽度', '宽度改'))
  await setDoc('> 引用正文\n>\n> | A | B |\n> |---|---|\n> | x | y |\n>\n> 引用结尾\n')
  check('引用表格的边框与正文保持相同缩进', await evaluate(`(() => { const table = document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)'); const quote = document.querySelector('.cm-md-blockquote'); const first = table.querySelector('.cm-md-table-cell').getBoundingClientRect(); const box = table.getBoundingClientRect(); const style = getComputedStyle(table); return table.classList.contains('cm-md-blockquote') && style.borderLeftWidth === getComputedStyle(quote).borderLeftWidth && first.left >= box.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth) })()`))
  check('引用正文前后的表格仍导出为表格', await evaluate(`(() => { const root = document.createElement('div'); root.innerHTML = window.__colamdExportDocumentHTML(); return !!root.querySelector('blockquote table') })()`), await exportHTML())
  check('引用竖线在表格上下不断开', await evaluate(`(() => {
    const table = document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)').getBoundingClientRect()
    const lines = [...document.querySelectorAll('.cm-content > .cm-line.cm-md-blockquote')].map(line => line.getBoundingClientRect())
    const above = lines.filter(line => line.bottom <= table.top + 1).at(-1)
    const below = lines.find(line => line.top >= table.bottom - 1)
    return Math.abs(table.top - above.bottom) < 1 && Math.abs(below.top - table.bottom) < 1
  })()`))
  await setDoc('| 模块 | 负责人 | 进度 | 日期 | 预算 | 说明 |\n|---|---|---|---|---|---|\n| 表格编辑 | 小林 | 进行中 | 2026-10-23 | 12,800.00 | 这是一段比较长的说明，用来观察列宽是否会给长文字留出足够的空间，避免每行只显示几个字。 |\n')
  check('按内容分配列宽，长说明比短内容更宽', await evaluate(`(() => { const cells = document.querySelectorAll('.cm-md-table-header .cm-md-table-cell'); return cells[5].offsetWidth > cells[0].offsetWidth * 2 && cells[5].offsetWidth > 200 && document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)').offsetWidth <= v.contentDOM.clientWidth })()`))
  const amounts = '| 编号 | 地区 | 产品 | 数量 | 金额（元） | 备注 |\n| :---: | :---: | :--- | ---: | ---: | :--- |\n| 156 | 深圳 | 测试记录 | 26 | 19,258.20 | 这条记录比较长，用来观察多行内容的行高，以及在长表格中连续输入时是否顺畅。 |\n| 157 | 杭州 | 设计稿 | 33 | 19,381.65 | 可以直接修改 |\n| 158 | 成都 | 文档模板 | 40 | 19,505.10 | 可以直接修改 |\n| 159 | 南京 | 图表素材 | 47 | 19,628.55 | 可以直接修改 |\n| 160 | 台北 | 接口说明 | 54 | 19,752.00 | 可以直接修改 |\n'
  for (const theme of themes) {
    await setDoc(amounts)
    await setTheme(theme)
    for (const width of ['780px', '540px']) {
      await evaluate(`v.contentDOM.style.width = '${width}'; v.contentDOM.style.maxWidth = '100%'`)
      check(`${theme} ${width} 数字金额和短地名不拆行，首行不向下偏移`, await evaluate(`Array.from(document.querySelectorAll('.cm-md-table-row')).slice(1).every(row => [0, 1, 3, 4].every(column => {
        const cell = row.querySelectorAll('.cm-md-table-cell')[column]
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode()) && !node.textContent.trim()) {}
        const range = document.createRange()
        range.selectNodeContents(node)
        const rect = range.getBoundingClientRect()
        const style = getComputedStyle(cell)
        return rect.height <= parseFloat(style.lineHeight) && rect.top - cell.getBoundingClientRect().top < parseFloat(style.lineHeight)
          && style.textAlign === (column <= 1 ? 'center' : 'right')
          && rect.left >= cell.getBoundingClientRect().left && rect.right <= cell.getBoundingClientRect().right
      }))`))
      check(`${theme} ${width} 表格保持文档宽度`, await evaluate(`document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)').offsetWidth <= v.contentDOM.clientWidth`))
    }
    await evaluate(`v.contentDOM.style.width = ''; v.contentDOM.style.maxWidth = ''`)
    await select('19,381.65', '19,381.65'.length)
    await type('1')
    check(`${theme} 金额末尾可编辑`, await doc() === amounts.replace('19,381.65', '19,381.651'))
    await key('z', MOD)
    check(`${theme} 金额编辑可撤销`, await doc() === amounts)
    check(`${theme} 导出保留金额和对齐`, (await exportHTML()).includes('<td style="overflow-wrap:anywhere;word-break:normal;text-align:right">19,381.65</td>'))
  }
  await setDoc('| 内容 | 备注 |\n|---|---|\n| ' + 'long_identifier_'.repeat(20) + ' | 自动折行 |\n')
  check('长英文仍能换行，表格不撑出文档', await evaluate(`(() => { const cell = document.querySelectorAll('.cm-md-table-row')[1].querySelector('.cm-md-table-cell'); return cell.offsetHeight > parseFloat(getComputedStyle(cell).lineHeight) * 2 && document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)').offsetWidth <= v.contentDOM.clientWidth })()`))
  // 长数字：放不下时拆行；打印时纸比窗口窄、脚本来不及重排，列宽按占比缩小，数字也不能出格
  const digits = '1234567890'.repeat(4)
  const numbersFit = () => evaluate(`(() => { const table = document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)'); const numbers = [...document.querySelectorAll('.cm-md-table-number')]; const gap = cell => { const text = [...cell.querySelectorAll('*'), cell].flatMap(node => [...node.childNodes]).find(node => node.nodeType === 3 && node.textContent.trim()); const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1); return range.getBoundingClientRect().top - cell.getBoundingClientRect().top - parseFloat(getComputedStyle(cell).paddingTop) }; return { table: table.getBoundingClientRect().width, content: v.contentDOM.getBoundingClientRect().width - parseFloat(getComputedStyle(v.contentDOM).paddingLeft) - parseFloat(getComputedStyle(v.contentDOM).paddingRight), overflow: numbers.filter(cell => cell.scrollWidth > cell.clientWidth + 1).length, blankFirstLine: numbers.filter(cell => gap(cell) > parseFloat(getComputedStyle(cell).lineHeight) / 2).length, text: numbers.map(cell => cell.textContent.trim()) } })()`)
  await setDoc(`| First | Second | Last |\n|---|---|---|\n| ${digits} | ${digits} | ${digits} |\n`)
  await sleep(300)
  let numbers = await numbersFit()
  check('放不下的长数字拆行，表格不撑出正文', numbers.table <= numbers.content + 1 && numbers.overflow === 0 && numbers.text.every(text => text === digits), JSON.stringify(numbers))
  check('拆行的长数字从第一行开始，不留空行', numbers.blankFirstLine === 0, JSON.stringify(numbers))
  const evenLines = await evaluate(`[...document.querySelectorAll('.cm-md-table-number')].map(cell => { const range = document.createRange(); range.selectNodeContents(cell); return Math.round(range.getBoundingClientRect().height / parseFloat(getComputedStyle(cell).lineHeight)) })`)
  check('一样长的数字列拆得一样', evenLines.every(lines => lines === evenLines[0] && lines > 1), JSON.stringify(evenLines))
  await setDoc(`| Long | Amount |\n|---|---:|\n| ${digits.repeat(2)} | 12,345.67 |\n`)
  await sleep(300)
  check('超长数字拆行时同表的短金额不拆', await evaluate(`(() => { const lines = cell => { const range = document.createRange(); range.selectNodeContents(cell); return range.getBoundingClientRect().height / parseFloat(getComputedStyle(cell).lineHeight) }; const [long, amount] = [...document.querySelectorAll('.cm-md-table-number')]; return lines(long) > 1.5 && lines(amount) < 1.5 && document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)').offsetWidth <= v.contentDOM.clientWidth })()`))
  const paperDigits = '1234567890'.repeat(2)
  await setDoc(`| First | Second | Last |\n|---|---|---|\n| ${paperDigits} | ${paperDigits} | ${paperDigits} |\n`)
  await sleep(300)
  check('放得下的数字在屏幕上不拆行', await evaluate(`[...document.querySelectorAll('.cm-md-table-number')].every(cell => cell.getClientRects().length && cell.getBoundingClientRect().height < parseFloat(getComputedStyle(cell).lineHeight) * 1.5 + 20)`), JSON.stringify(await numbersFit()))
  await send('Emulation.setEmulatedMedia', { media: 'print' })
  numbers = await evaluate(`(() => { const content = v.contentDOM; const saved = content.style.cssText; content.style.cssText += ';width:520px;max-width:520px;min-width:0'; const table = document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)').getBoundingClientRect().width; const inner = content.getBoundingClientRect().width - parseFloat(getComputedStyle(content).paddingLeft) - parseFloat(getComputedStyle(content).paddingRight); const overflow = [...document.querySelectorAll('.cm-md-table-number')].filter(cell => cell.scrollWidth > cell.clientWidth + 1).length; content.style.cssText = saved; return { table, inner, overflow } })()`)
  await send('Emulation.setEmulatedMedia', { media: '' })
  check('打印时纸比窗口窄，表格按占比缩到纸宽且数字不出格', numbers.table <= numbers.inner + 1 && numbers.overflow === 0, JSON.stringify(numbers))
  await setDoc(fixture)
  await setDoc('| 公式 | 说明 |\n|---|---|\n| $E=mc^2$ | 行内公式 |\n')
  check('表格内现有行内公式正常渲染并导出', await evaluate(`!!document.querySelector('.cm-md-table-cell .katex')`) && (await exportHTML()).includes('katex'))
  const multiple = '| A | B |\n|---|---:|\n| first | 123 |\n|  | empty |\n\n> | C | D |\n> |---|---|\n> | quoted | tail |\n'
  await setDoc(multiple)
  const tableSnapshot = () => evaluate(`JSON.stringify([...v.contentDOM.querySelectorAll('.cm-md-table-row')].map(row => ({
    table: v.posAtDOM(row.closest('.cm-md-table-widget')), row: row.dataset.tableRow,
    cells: [...row.querySelectorAll('.cm-md-table-cell')].map(cell => [cell.textContent, cell.dataset.column, cell.className, getComputedStyle(cell).textAlign])
  })))`)
  for (const [word, text] of [['first', '**bold**'], ['123', 'word'], ['quoted', '引用文字']]) {
    await select(word, 0, word.length)
    await type(text)
    await sleep(100)
    const edited = await doc(), partial = await tableSnapshot()
    await setDoc(edited)
    check(`${word} 局部更新与完整重建的单元格和后续表格位置一致`, await tableSnapshot() === partial)
  }
  await setDoc(fixture)

  await select('苹果', 2)
  await type('|测试')
  check('输入竖线自动转义', (await doc()).includes('苹果\\|测试'))
  check('转义竖线不会增加列数', await evaluate(`document.querySelectorAll('.cm-md-table-row')[1].querySelectorAll('.cm-md-table-cell').length`) === 3)
  await key('z', MOD)
  await select('苹果', 2)
  await paste('`a || b`')
  check('粘贴完整代码保留连续竖线且不增加列数', (await doc()).includes('苹果`a || b`') && await evaluate(`document.querySelectorAll('.cm-md-table-row')[1].querySelectorAll('.cm-md-table-cell').length`) === 3, await doc())
  await key('z', MOD)
  await select('苹果', 0, 2)
  await paste('第一行\n第二行')
  check('多行粘贴保留在单元格内', (await doc()).includes('第一行<br>第二行'), await doc())
  await key('z', MOD)
  // 反斜杠和字面竖线：按看到的字编辑，不改变分格
  const S = '\\'
  const rowCells = row => evaluate(`Array.from(document.querySelectorAll('.cm-md-table-row')[${row}].querySelectorAll('.cm-md-table-cell')).map(c => c.textContent.trim())`)
  const exportCells = async () => [...(await exportHTML()).matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(match => match[1])
  const cursor = (pos, assoc = 0, userEvent) => evaluate(`(() => { const S = v.state.selection.constructor; v.dispatch({selection:S.create([S.cursor(${pos},${assoc})]),userEvent:${JSON.stringify(userEvent)}}); v.focus() })()`)
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  for (const [name, source, text, expected] of [
    ['已有两格', '| A | B |\n|---|---|\n| x | end |\n', 'a`\t`b', [['a`', '`b']]],
    ['同时扩列增行', '| A | B |\n|---|---|\n| x | end |\n', 'a`\t`b\t尾\n😀`\t`c\t末', [['a`', '`b', '尾'], ['😀`', '`c', '末']]],
    ['引用容器', '> | A | B |\n> |---|---|\n> | x | end |\n', 'a`\t`b', [['a`', '`b']]],
  ]) {
    await setDoc(source)
    await sleep(550)
    await select('x')
    await paste(text)
    const pasted = await doc()
    const actual = await Promise.all(expected.map((_, index) => rowCells(index + 1)))
    check(`${name} TSV反引号不跨格配对`, same(actual, expected), JSON.stringify({ actual, source: pasted }))
    await key('z', MOD)
    check(`${name} TSV保护与扩展一步撤销`, await doc() === source, await doc())
    await key('z', MOD | 8)
    check(`${name} TSV保护与扩展一步重做`, await doc() === pasted, await doc())
  }
  const compactSlash = '|A|B|\n|---|---|\n|x|y|\n'
  const compactTyped = `|A|B|\n|---|---|\n|x${S}${S}|y|\n`
  await setDoc(compactSlash)
  await cursor(compactSlash.indexOf('x') + 1, -1)
  await type(S)
  check('紧凑格尾输入反斜杠不转义右侧竖线', await doc() === compactTyped && same(await rowCells(1), [`x${S}`, 'y']), JSON.stringify([await doc(), await rowCells(1)]))
  check('格尾反斜杠导出仍是两格', same(await exportCells(), [`x${S}`, 'y']), await exportHTML())
  await key('z', MOD)
  check('格尾反斜杠一步撤销', await doc() === compactSlash, await doc())
  await key('z', MOD | 8)
  check('格尾反斜杠可重做', await doc() === compactTyped, await doc())
  await setDoc(compactSlash)
  const compactEnd = await evaluate(`(() => { const range = document.createRange(); range.selectNodeContents(document.querySelectorAll('.cm-md-table-row')[1].querySelector('.cm-md-table-cell')); const r = range.getBoundingClientRect(); return {x: r.right + 2, y: r.top + r.height / 2} })()`)
  for (const kind of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: kind, ...compactEnd, button: 'left', clickCount: 1 })
  await sleep(50)
  await type(S)
  check('点击紧凑格尾后输入反斜杠保持两格', await doc() === compactTyped, await doc())

  const escapedPipe = `|A|B|\n|---|---|\n|a${S}|b|c|\n`
  for (const [name, offset] of [['转义竖线前', 0], ['点在转义符和竖线之间后', 1]]) {
    await setDoc(escapedPipe)
    await cursor(escapedPipe.indexOf(`a${S}|`) + 1 + offset, 0, 'select.pointer')
    if (offset) check('点击不停在隐藏的转义符后', await head() === escapedPipe.indexOf(`${S}|`), await head())
    await type(S)
    check(`${name}输入反斜杠保留后面的格子`, await doc() === `|A|B|\n|---|---|\n|a${S}${S}${S}|b|c|\n` && same(await rowCells(1), [`a${S}|b`, 'c']), JSON.stringify([await doc(), await rowCells(1)]))
  }
  check('转义竖线前的反斜杠导出保留字面竖线和后面的格子', same(await exportCells(), [`a${S}|b`, 'c']), await exportHTML())

  const literal = `| A | B |\n|---|---|\n| a${S}|b | c |\n`
  const removed = '| A | B |\n|---|---|\n| ab | c |\n'
  await setDoc(literal)
  await cursor(literal.indexOf('|b') + 1)
  await key('Backspace')
  check('Backspace 删除字面竖线时连同转义符', await doc() === removed && same(await rowCells(1), ['ab', 'c']), await doc())
  await key('z', MOD)
  check('删除字面竖线一步撤销', await doc() === literal, await doc())
  await key('z', MOD | 8)
  check('删除字面竖线可重做', await doc() === removed, await doc())
  await setDoc(literal)
  await cursor(literal.indexOf(`${S}|`))
  await key('Delete')
  check('Delete 删除字面竖线时连同转义符', await doc() === removed, await doc())
  await setDoc(literal)
  await select(`${S}|`, 0, 1)
  await key('Delete')
  check('只选中隐藏的转义符删除时整对删除', await doc() === removed, await doc())
  await setDoc(literal)
  await select('|b', 0, 1)
  await key('Backspace')
  check('选中字面竖线删除时连同转义符', await doc() === removed, await doc())
  await setDoc(literal)
  await select('|b', 0, 1)
  const cut = await evaluate(`(() => { const data = new DataTransfer(); v.contentDOM.dispatchEvent(new ClipboardEvent('cut', {clipboardData: data, bubbles: true, cancelable: true})); return data.getData('text/plain') })()`)
  check('剪切字面竖线时连同转义符', await doc() === removed && cut === '|', JSON.stringify([await doc(), cut]))
  await key('z', MOD)
  check('剪切字面竖线一步撤销', await doc() === literal, await doc())

  await setDoc(literal)
  await cursor(literal.indexOf(`a${S}|`) + 1)
  await key('ArrowRight')
  check('右方向键一步跨过字面竖线', await head() === literal.indexOf('|b') + 1, await head())
  await key('ArrowLeft')
  check('左方向键一步退回字面竖线前', await head() === literal.indexOf(`${S}|`), await head())

  const slashes = `| A | B |\n|---|---|\n| a${S.repeat(4)}b | c |\n`
  await setDoc(slashes)
  await cursor(slashes.indexOf('a') + 3)
  await key('Backspace')
  check('连续反斜杠一次删掉一个', await doc() === `| A | B |\n|---|---|\n| a${S}${S}b | c |\n` && same(await rowCells(1), [`a${S}b`, 'c']), await doc())

  const lone = `|A|B|\n|---|---|\n|x${S}a|y|\n`
  await setDoc(lone)
  await cursor(lone.indexOf('a|') + 1, -1)
  await key('Backspace')
  check('删掉落单反斜杠后的字不转义右侧竖线', await doc() === compactTyped && same(await rowCells(1), [`x${S}`, 'y']), await doc())

  const loneBefore = `| A | B |\n|---|---|\n| ${S}a | b |\n`
  await setDoc(loneBefore)
  await cursor(loneBefore.indexOf(`${S}a`) + 1)
  await type('|')
  check('落单反斜杠后输入竖线两个字都保留', await doc() === `| A | B |\n|---|---|\n| ${S}${S}${S}|a | b |\n` && same(await rowCells(1), [`${S}|a`, 'b']), await doc())

  const loneEnd = `| A | B |\n|---|---|\n| x${S} | y |\n`
  await setDoc(loneEnd)
  await cursor(loneEnd.indexOf(`x${S}`) + 2)
  await key('Enter', 8)
  check('落单反斜杠后换行仍是格内换行', await doc() === `| A | B |\n|---|---|\n| x${S}${S}<br> | y |\n` && (await exportCells())[0] === `x${S}<br>`, JSON.stringify([await doc(), await exportHTML()]))

  const breakCell = '| A | B |\n|---|---|\n| a<br>b | c |\n'
  await setDoc(breakCell)
  await cursor(breakCell.indexOf('<br>'))
  await type(S)
  check('格内换行前输入反斜杠不转义换行', await doc() === `| A | B |\n|---|---|\n| a${S}${S}<br>b | c |\n`, await doc())

  await setDoc(compactSlash)
  await select('x')
  await paste(`p${S}\tq${S}`)
  check('多格粘贴以反斜杠结尾不转义竖线', await doc() === `|A|B|\n|---|---|\n|p${S}${S}|q${S}${S}|\n` && same(await rowCells(1), [`p${S}`, `q${S}`]), await doc())
  await setDoc(fixture)

  // 选区端点停在隐藏的转义符后：不删没选中的竖线；Shift+右方向键一次跨过一对；从别处落到一对中间时停在它前面
  const pipeAt = literal.indexOf(`${S}|`)
  const selection = () => evaluate('[v.state.selection.main.anchor, v.state.selection.main.head]')
  await setDoc(literal)
  await evaluate(`v.dispatch({selection:{anchor:${literal.indexOf('a')},head:${pipeAt + 1}}}); v.focus()`)
  check('选区终点不停在隐藏的转义符后', same(await selection(), [literal.indexOf('a'), pipeAt]), JSON.stringify(await selection()))
  await type('X')
  check('选到转义对前输入不删字面竖线', await doc() === literal.replace('a', 'X') && same(await rowCells(1), ['X|b', 'c']), await doc())
  await setDoc(literal)
  await evaluate(`v.dispatch({changes:{from:${literal.indexOf('a')},to:${pipeAt + 1},insert:'X'},userEvent:'input.type'})`)
  check('改动终点在隐藏转义符后时不越过字面竖线', await doc() === literal.replace('a', 'X'), await doc())
  await setDoc(literal)
  await cursor(literal.indexOf('a'), 1)
  await key('ArrowRight', 8)
  await key('ArrowRight', 8)
  check('Shift+右方向键一次跨过字面竖线', same(await selection(), [literal.indexOf('a'), pipeAt + 2]), JSON.stringify(await selection()))
  await type('X')
  check('选中字和字面竖线后输入一起替换', await doc() === removed.replace('ab', 'Xb'), await doc())
  await setDoc(literal)
  await cursor(pipeAt + 1)
  check('从别处落到转义对中间时停在它前面', await head() === pipeAt, await head())

  // 拖动移动文字：CodeMirror 的 move.drop 一笔里有删有插，也按看到的字改原文
  const dragged = `|A|B|\n|---|---|\n|x${S}y|z|\n\n尾巴\n`
  await setDoc(dragged)
  await select('y', 0, 1)
  await evaluate(`(() => {
    const data = new DataTransfer()
    v.contentDOM.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true, cancelable: true }))
    data.setData('text/plain', 'y')
    const target = v.coordsAtPos(${dragged.indexOf('尾巴')})
    v.contentDOM.dispatchEvent(new DragEvent('drop', { dataTransfer: data, clientX: target.left + 1, clientY: (target.top + target.bottom) / 2, bubbles: true, cancelable: true }))
  })()`)
  await sleep(100)
  check('拖走落单反斜杠后的字不转义右侧竖线', await doc() === `|A|B|\n|---|---|\n|x${S}${S}|z|\n\ny尾巴\n` && same(await rowCells(1), [`x${S}`, 'z']), await doc())
  check('拖动改写后仍选中移动的文字', await evaluate('v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)') === 'y', JSON.stringify(await selection()))
  await key('z', MOD)
  check('拖动移动一步撤销', await doc() === dragged, await doc())
  await setDoc(dragged)
  await evaluate(`v.dispatch({changes:{from:${dragged.indexOf('z')},insert:'p|q'},selection:{anchor:${dragged.indexOf('z')},head:${dragged.indexOf('z') + 3}},userEvent:'input.drop'})`)
  check('拖进格子的竖线自动转义', (await doc()).includes(`|p${S}|qz|`) && same(await rowCells(1), [`x${S}y`, 'p|qz']), await doc())
  check('拖入改写后选区包含转义后的全部文字', await evaluate('v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)') === `p${S}|q`, JSON.stringify(await selection()))

  // 行内代码里的反斜杠与竖线都保留原文，删的时候一次一个。
  const codeCell = `| A | B |\n|---|---|\n| \`C:${S}${S}dir a${S}|b\` | x |\n`
  await setDoc(codeCell)
  check('行内代码里的反斜杠原样显示', (await rowCells(1))[0].includes(`C:${S}${S}dir a${S}|b`) && (await exportCells())[0].replace(/<[^>]+>/g, '') === `C:${S}${S}dir a${S}|b`, JSON.stringify([await rowCells(1), await exportCells()]))
  await cursor(codeCell.indexOf('dir'))
  await key('Backspace')
  check('行内代码里删反斜杠一次删一个', await doc() === codeCell.replace(`${S}${S}dir`, `${S}dir`), await doc())
  await setDoc(codeCell)
  await cursor(codeCell.indexOf('dir'))
  await type(S)
  check('行内代码里输入反斜杠就是一个', await doc() === codeCell.replace(`${S}${S}dir`, `${S}${S}${S}dir`), await doc())

  const codePipe = `| A | B |\n|---|---|\n| \`a${S}|b\` | c |\n`
  await setDoc(codePipe)
  await cursor(codePipe.indexOf(`${S}|`))
  await type(S)
  const codePipeTyped = codePipe.replace(`${S}|`, `${S.repeat(2)}|`)
  check('代码竖线前输入一根反斜杠只增加一根并保留两格', await doc() === codePipeTyped && same(await rowCells(1), [`a${S}${S}|b`, 'c']), JSON.stringify([await doc(), await rowCells(1)]))
  await key('z', MOD)
  check('代码转义接缝修正一步撤销', await doc() === codePipe, await doc())
  await setDoc(codePipeTyped)
  await cursor(codePipeTyped.indexOf(`${S.repeat(2)}|`) + 1)
  await key('Backspace')
  check('代码竖线前的单根反斜杠可以删除并保留分格', same(await rowCells(1), [`a${S}|b`, 'c']) && await doc() === codePipe, JSON.stringify([await doc(), await rowCells(1)]))
  check('删除后的光标退回一个字', await head() === codePipeTyped.indexOf(`${S.repeat(2)}|`), await head())
  await setDoc(codePipeTyped)
  const codeSlashAt = codePipeTyped.indexOf(`${S.repeat(2)}|`)
  await select(`${S.repeat(2)}|`, 0, 1)
  await evaluate(`v.dispatch({changes:[{from:${codeSlashAt},to:${codeSlashAt + 1}},{from:v.state.doc.length,insert:${JSON.stringify(S)}}],userEvent:'move.drop'})`)
  check('代码反斜杠可移出单元格，源与目标各改一次', await doc() === codePipe + S && same(await rowCells(1), [`a${S}|b`, 'c']), await doc())

  for (let count = 3; count > 0; count--) {
    const source = codePipe.replace(`${S}|`, `${S.repeat(count)}|`)
    const expected = codePipe.replace(`${S}|`, `${S.repeat(count - 1)}|`)
    await setDoc(source)
    await cursor(source.indexOf('|b'))
    await key('Backspace')
    check(`代码反斜杠 ${count}→${count - 1} 保持源码、显示及两格`, await doc() === expected && same(await rowCells(1), [`a${S.repeat(count - 1)}|b`, 'c']), JSON.stringify([await doc(), await rowCells(1)]))
    await key('z', MOD)
    check(`代码删除 ${count}→${count - 1} 一步撤销`, await doc() === source, await doc())
    await key('z', MOD | 8)
    check(`代码删除 ${count}→${count - 1} 重做`, await doc() === expected, await doc())
  }

  // 光标的源码位置正确还不够：格内少一个字时，列宽不能重分配，把整格和光标推到另一处。
  const caretLayoutFixture = `| 试哪一行 | 代码 | 旁边的格子 |\n| --- | --- | --- |\n| 竖线前：三个反斜杠 | \`a${S.repeat(3)}|b\` | 保持不变 |\n| 竖线前：一个反斜杠 | \`a${S}|b\` | 保持不变 |\n| 竖线前：没有反斜杠 | \`a|b\` | 保持不变 |\n`
  const columnBounds = () => evaluate(`[...document.querySelector('.cm-md-table-header').querySelectorAll('.cm-md-table-cell')].map(cell => { const r=cell.getBoundingClientRect(); return {left:r.left,width:r.width} })`)
  const sameColumns = (before, after) => before.length === after.length && before.every((cell, column) => Math.abs(cell.left-after[column].left) <= 1 && Math.abs(cell.width-after[column].width) <= 1)
  const caretPoint = pos => evaluate(`(() => { const r=v.coordsAtPos(${pos}); return {left:r.left,top:r.top} })()`)
  for (const theme of themes) {
    await setTheme(theme)
    for (const direction of ['Backspace', 'Delete']) {
      await setDoc(caretLayoutFixture)
      const columns = await columnBounds()
      const start = caretLayoutFixture.indexOf(S)
      await select(S.repeat(3), direction === 'Backspace' ? 3 : 0)
      await sleep(550)
      for (let count=3; count>0; count--) {
        const nextHead = start + (direction === 'Backspace' ? count-1 : 0)
        const expectedPoint = await caretPoint(nextHead)
        await key(direction)
        await sleep(80)
        const point = await caretPoint(await head())
        const drawn = await evaluate(`(() => { const r=document.querySelector('.cm-cursor').getBoundingClientRect(); return {left:r.left,top:r.top} })()`)
        const expected = caretLayoutFixture.replace(S.repeat(3)+'|', S.repeat(count-1)+'|')
        check(`${theme} ${direction} 连删 ${count}→${count-1} 内容与光标位置正确`, await doc() === expected && await head() === nextHead, JSON.stringify({doc:await doc(),head:await head(),nextHead}))
        check(`${theme} ${direction} 连删 ${count}→${count-1} 列宽保持稳定`, sameColumns(columns, await columnBounds()), JSON.stringify({before:columns,after:await columnBounds()}))
        check(`${theme} ${direction} 连删 ${count}→${count-1} 可见光标只随删字移动`, Math.abs(point.left-expectedPoint.left)<=1 && Math.abs(point.top-expectedPoint.top)<=1 && Math.abs(drawn.left-point.left)<=1 && Math.abs(drawn.top-point.top)<=1, JSON.stringify({expectedPoint,point,drawn}))
      }
      await key('z', MOD)
      check(`${theme} ${direction} 连删撤销保持原文与列宽`, await doc() === caretLayoutFixture && sameColumns(columns, await columnBounds()), await doc())
      await key('z', MOD | 8)
      check(`${theme} ${direction} 连删重做保持原文与列宽`, await doc() === caretLayoutFixture.replace(S.repeat(3)+'|', '|') && sameColumns(columns, await columnBounds()), await doc())
      await type(S)
      await sleep(100)
      check(`${theme} ${direction} 原位置接着输入仍保持列宽`, await head() === start+1 && sameColumns(columns, await columnBounds()) && await doc() === caretLayoutFixture.replace(S.repeat(3)+'|', S+'|'), await doc())
    }
  }
  await setTheme('elegant')
  const growingNumber = '| 说明 | 数值 | 备注 |\n|---|---|---|\n| 这是一段较长的说明文字 | 1 | 保持不变 |\n'
  await setDoc(growingNumber)
  const numberColumns = await columnBounds()
  await select('1', 1)
  await type('234567890'.repeat(12))
  await sleep(200)
  check('格内追加长数字保持列宽并允许换行', sameColumns(numberColumns, await columnBounds()) && await evaluate(`(() => { const cell=document.querySelector('.cm-md-table-number'); const range=document.createRange(); range.selectNodeContents(cell); return range.getBoundingClientRect().height>parseFloat(getComputedStyle(cell).lineHeight)*1.5 && cell.scrollWidth<=cell.clientWidth+1 })()`), JSON.stringify(await columnBounds()))

  const replaceFixture = '正文 axb。\n\n| A | B |\n|---|---|\n| axb axb | `axb` |\n| a\\|b | tail |\n'
  const search = async (query, replacement, all = true) => {
    await sendToWindow('editor:search')
    await evaluate(`(() => {
      const query = document.querySelector('.search-input:not(.search-replace-input)')
      query.value = ${JSON.stringify(query)}; query.dispatchEvent(new Event('input',{bubbles:true}))
      const replace = document.querySelector('.search-replace-input'); replace.value=${JSON.stringify(replacement)}
    })()`)
    const count = await evaluate(`document.querySelector('.search-count').textContent`)
    if (replacement !== undefined) await evaluate(`document.querySelectorAll('.search-action')[${all ? 1 : 0}].click()`)
    await sleep(80)
    return count
  }
  const hideSearch = () => evaluate(`document.querySelector('.search-close').click()`)
  const hiddenSearch = '| A | B |\n|---|---|\n| [label](secret-target "private-title") | a<br>b |\n| <span title="attribute-hidden">visible</span> | end |\n'
  await setDoc(hiddenSearch)
  for (const query of ['secret-target', 'private-title', 'br', 'attribute-hidden']) {
    const count = await search(query)
    check(`渲染搜索排除隐藏源码 ${query}`, count === '0/0' && await doc() === hiddenSearch, JSON.stringify({ count, source: await doc() }))
    await hideSearch()
  }
  await sleep(550)
  const labelCount = await search('label', 'done')
  check('链接显示文字可以替换且保留目标及换行', labelCount === '1/1' && await doc() === hiddenSearch.replace('[label]', '[done]'), await doc())
  await hideSearch(); await key('z', MOD)
  check('链接文字替换一步撤销且保留隐藏结构', await doc() === hiddenSearch, await doc())
  // 特殊字符的输入与查找替换使用真实搜索面板，在每套主题下都覆盖同一组旧问题。
  for (const theme of themes) {
    await setTheme(theme)
    await setDoc(replaceFixture)
    await sleep(550)
    const count = await search('x', '|')
    const expected = replaceFixture.replace('正文 axb', '正文 a|b').replace('axb axb', `a${S}|b a${S}|b`).replace('`axb`', '`a|b`')
    check(`${theme} 特殊字符替换保持普通格与代码格`, count === '1/4' && await doc() === expected && same(await rowCells(1), ['a|b a|b', 'a|b']), JSON.stringify({count,doc:await doc()}))
    await hideSearch(); await key('z', MOD)
    check(`${theme} 全部替换一步撤销`, await doc() === replaceFixture, await doc())
    await key('z', MOD | 8)
    check(`${theme} 全部替换重做保持分格`, await doc() === expected, await doc())
    const visiblePipes = await search('|', S)
    check(`${theme} 按显示文字替换竖线为反斜杠`, visiblePipes === '1/5' && same(await rowCells(1), [`a${S}b a${S}b`, `a${S}b`]) && same(await rowCells(2), [`a${S}b`, 'tail']), JSON.stringify({visiblePipes,doc:await doc()}))
    await hideSearch()
    await search(S, '')
    check(`${theme} 查找删除反斜杠保持普通格和代码格`, same(await rowCells(1), ['ab ab', 'ab']) && same(await rowCells(2), ['ab', 'tail']), await doc())
    await hideSearch()
    const source = '|A|B|\n|---|---|\n|axb|`c|d`|\n'
    await setDoc(source)
    await cursor(source.indexOf('x') + 1)
    await type('`')
    check(`${theme} 新反引号不跨格配对且光标跟随输入`, await doc() === source.replace('x', 'x'+S+'`') && same(await rowCells(1), ['ax`b', 'c|d']) && await head() === (await doc()).indexOf('`b')+1, JSON.stringify({doc:await doc(),head:await head()}))
    await key('z', MOD)
    check(`${theme} 跨格反引号保护一步撤销`, await doc() === source, await doc())
  }
  await setTheme('elegant')
  await setDoc(replaceFixture)
  const replaceCount = await search('x', '|')
  const replacedFixture = replaceFixture.replace('正文 axb', '正文 a|b').replace('axb axb', `a${S}|b a${S}|b`).replace('`axb`', '`a|b`')
  check('查找替换覆盖正文、同格多匹配和代码格', replaceCount === '1/4' && await doc() === replacedFixture && same(await rowCells(1), ['a|b a|b', 'a|b']), JSON.stringify([replaceCount, await doc(), await rowCells(1)]))
  await hideSearch(); await key('z', MOD)
  check('全部替换只需一步撤销', await doc() === replaceFixture, await doc())
  await key('z', MOD | 8)
  check('全部替换重做仍保留分格', await doc() === replacedFixture, await doc())
  const pipeCount = await search('|', 'X')
  check('搜索竖线排除格线，替换隐藏转义后的文字', pipeCount === '1/5' && await evaluate(`document.querySelector('.search-count').textContent`) === '0/0' && same(await rowCells(1), ['aXb aXb', 'aXb']) && same(await rowCells(2), ['aXb', 'tail']), JSON.stringify([pipeCount, await doc()]))
  await hideSearch()
  await setDoc(replaceFixture)
  await search('a|b', 'done', false)
  check('可按显示文字找到转义竖线所在格并单次替换', same(await rowCells(2), ['done', 'tail']) && (await doc()).includes('| done | tail |'), await doc())
  await hideSearch()
  await setDoc('|A|B|\n|---|---|\n|aaa|`a'+S+'|b`|\n')
  await search('aa', 'X')
  check('相互重叠的查找结果只替换一次', (await doc()).includes('|Xa|'), await doc())
  await hideSearch()
  await search(S, '')
  check('查找删除代码反斜杠保持代码和分格', same(await rowCells(1), ['Xa','a|b']), await doc())
  await hideSearch()
  const ticking = '|A|B|\n|---|---|\n|axb|`c|d`|\n'
  await setDoc(ticking)
  await cursor(ticking.indexOf('x') + 1)
  await type('`')
  check('输入反引号不会与隔壁代码格配对', await doc() === ticking.replace('x', 'x'+S+'`') && same(await rowCells(1), ['ax`b', 'c|d']), JSON.stringify([await doc(), await rowCells(1)]))
  check('反引号保护后光标仍跟在输入文字后', await head() === (await doc()).indexOf('`b') + 1, await head())
  await key('z', MOD)
  check('跨格反引号保护与输入一步撤销', await doc() === ticking, await doc())
  await setDoc('İ\n\n|A|B|\n|---|---|\n|x|`a|b`|\n')
  await evaluate(`document.getElementById('source-toggle-btn').click()`)
  await search('x', '|')
  check('源码模式替换直接修改原文', await evaluate(`document.getElementById('source-editor').value.includes('|||')`), await evaluate(`document.getElementById('source-editor').value`))
  await hideSearch()
  await evaluate(`document.getElementById('source-toggle-btn').click()`)
  const wordSource = '| A | B |\n|---|---|\n' + [0,1,2,3].map(count => '| `a'+S.repeat(count)+'|b` | end |').join('\n') + '\n\n' +
    '> 引用前文\n>\n> - | A | B |\n>   |---|---|\n>   | [link](https://example.com/`a|b`) | END |\n>   | <span title="`c|d`">text</span> | html-end |\n>   | [引用标签][reference] | ref-end |\n>\n> 引用后文\n\n[reference]: https://example.com/reference\n'
  const wordPath = join(dir, 'code-pipes.docx')
  await mainEval(`(async () => {
    const require = process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')
    const {markdownToDocx} = require('./dist/main/chunks/docx-export.js')
    const bytes = await markdownToDocx({content:${JSON.stringify(wordSource)},sourcePath:null})
    process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(wordPath)},bytes)
  })()`)
  const docxRequire = createRequire(createRequire(import.meta.url).resolve('docx'))
  const wordZip = await docxRequire('jszip').loadAsync(readFileSync(wordPath))
  const wordXML = await wordZip.file('word/document.xml').async('string')
  const wordRows = [...wordXML.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map(row => [...row[0].matchAll(/<w:tc[ >]([\s\S]*?)<\/w:tc>/g)].map(cell => [...cell[1].matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/g)].map(text => text[1]).join('')))
  check('真实 Word 文件保留代码反斜杠、竖线和两列', same(wordRows.slice(0, 5), [['A','B'], ...[0,1,2,3].map(count => ['a'+S.repeat(count)+'|b','end'])]), JSON.stringify(wordRows))
  const wordRels = await wordZip.file('word/_rels/document.xml.rels').async('string')
  const quoteParagraphs = [...wordXML.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(match => match[0]).filter(paragraph => /引用前文|引用后文/.test(paragraph))
  check('真实 Word 导出引用内列表表格并保持链接和普通引用样式',
    same(wordRows.slice(5), [['A','B'], ['link','END'], ['text','html-end'], ['引用标签','ref-end']]) && wordRels.includes('https://example.com/`a|b`') &&
    quoteParagraphs.length === 2 && quoteParagraphs.every(paragraph => paragraph.includes('<w:pBdr>') && /<w:i[\s/>]/.test(paragraph)), JSON.stringify(wordRows))

  const mathCell = `| A | B |\n|---|---|\n| $a${S}${S}b$ | c |\n`
  await setDoc(mathCell)
  await cursor(mathCell.indexOf('b$'))
  await key('Backspace')
  check('公式里的双反斜杠逐个删除', await doc() === mathCell.replace(`${S}${S}b`, `${S}b`), await doc())

  const movable = '|A|B|\n|---|---|\n|x|y|\n|p|q|\n'
  for (const [direction, word] of [['ArrowDown', 'x'], ['ArrowUp', 'p']]) {
    await setDoc(movable)
    await select(word)
    await key(direction, 1)
    check(`Alt+${direction}移动整行保留表格结构`, await doc() === '|A|B|\n|---|---|\n|p|q|\n|x|y|\n' && same(await rowCells(1), ['p', 'q']) && same(await rowCells(2), ['x', 'y']), await doc())
    await key('z', MOD)
    check(`Alt+${direction}移动整行一步撤销`, await doc() === movable, await doc())
  }
  const borderless = 'A|B\n---|---\nx|y\np|q\n'
  await setDoc(borderless)
  await select('x')
  await key('ArrowDown', 1 | 8)
  check('无边框表格复制整行保留换行和分格', await doc() === 'A|B\n---|---\nx|y\nx|y\np|q\n' && same(await rowCells(2), ['x', 'y']), await doc())
  await key('z', MOD)
  check('复制整行一步撤销', await doc() === borderless, await doc())

  await setDoc(compactSlash)
  const composeAt = compactSlash.indexOf('x') + 1
  const composingSelection = await evaluate(`(() => {
    const S = v.state.selection.constructor
    const tr = v.state.update({changes:{from:${composeAt},insert:'中'},selection:S.create([S.cursor(${composeAt + 1},1)]),userEvent:'input.type.compose'})
    return { head:tr.newSelection.main.head, assoc:tr.newSelection.main.assoc }
  })()`)
  check('组合事务保留输入法给定的光标朝向', same(composingSelection, { head: composeAt + 1, assoc: 1 }), JSON.stringify(composingSelection))

  // 紧凑表格的格尾和右侧竖线是同一个位置：各种方式把光标放到格尾再输入，字都留在这一格
  const tight = '|A|B|\n|---|---|\n|xy|zw|\n'
  const tightEnd = tight.indexOf('xy') + 2
  for (const [name, place] of [
    ['Tab 选中后按右方向键', async () => { await cursor(tight.indexOf('zw'), 1); await key('Tab', 8); await key('ArrowRight') }],
    ['程序放在格尾的光标', () => cursor(tightEnd)],
    ['从下一格按左方向键', async () => { await cursor(tight.indexOf('zw'), 1); await key('ArrowLeft') }],
  ]) {
    await setDoc(tight)
    await place()
    await type('q')
    check(`紧凑表格${name}后输入留在当前格`, await doc() === tight.replace('xy', 'xyq'), await doc())
  }
  await setDoc(tight)
  await cursor(tightEnd, -1)
  await type('|')
  await type('q')
  check('格尾输入竖线后接着输入仍在当前格', await doc() === tight.replace('xy', `xy${S}|q`), await doc())
  await setDoc(tight)
  await cursor(tight.indexOf('zw'), 1)
  await type(S)
  check('紧凑表格格首输入反斜杠留在当前格', await doc() === tight.replace('zw', `${S}zw`) && same(await rowCells(1), ['xy', `${S}zw`]), await doc())
  await setDoc(fixture)

  // 同一行跨格复制：富文本口味是选中的这几格组成的一行表格，没选到的字不补进去
  const copyRow = '| 名称 | 数量 | 备注 |\n|---|---:|---|\n| 苹果 | 12 |  |\n'
  const copyEvent = () => evaluate(`(() => { const data = new DataTransfer(); v.contentDOM.dispatchEvent(new ClipboardEvent('copy', {clipboardData: data, bubbles: true, cancelable: true})); return {plain: data.getData('text/plain'), html: data.getData('text/html')} })()`)
  await setDoc(copyRow)
  await select('果 | 12', 0, '果 | 12'.length)
  let copied = await copyEvent()
  check('跨格复制的纯文本仍是原文', copied.plain === '果 | 12', JSON.stringify(copied))
  check('跨格复制的富文本是一行表格且不补未选的字', copied.html === '<table><tbody><tr><td style="overflow-wrap:anywhere;word-break:normal;text-align:left">果</td><td style="overflow-wrap:anywhere;word-break:normal;text-align:right">12</td></tr></tbody></table>', copied.html)
  await select('名称 | 数', 0, '名称 | 数'.length)
  copied = await copyEvent()
  check('表头跨格复制保留表头', copied.html === '<table><thead><tr><th style="overflow-wrap:anywhere;word-break:normal;text-align:left">名称</th><th style="overflow-wrap:anywhere;word-break:normal;text-align:right">数</th></tr></thead></table>', copied.html)
  await select('果', 0, copyRow.lastIndexOf('|') - copyRow.indexOf('果'))
  copied = await copyEvent()
  check('跨到空格子的复制保留空格子', copied.html === '<table><tbody><tr><td style="overflow-wrap:anywhere;word-break:normal;text-align:left">果</td><td style="overflow-wrap:anywhere;word-break:normal;text-align:right">12</td><td style="overflow-wrap:anywhere;word-break:normal;text-align:left"></td></tr></tbody></table>', copied.html)
  await setDoc('| 名称 |  | 备注 |\n|---|---|---|\n| a | b | c |\n')
  await select('称', 0, '称 |  | 备'.length)
  copied = await copyEvent()
  check('表头里的空格子标为表头', await evaluate(`document.querySelector('.cm-md-table-header .cm-md-table-cell:has(.cm-md-table-input)').getAttribute('role')`) === 'columnheader')
  check('表头里的空格子跨格复制仍是表头', copied.html === '<table><thead><tr><th style="overflow-wrap:anywhere;word-break:normal;text-align:left">称</th><th style="overflow-wrap:anywhere;word-break:normal;text-align:left"></th><th style="overflow-wrap:anywhere;word-break:normal;text-align:left">备</th></tr></thead></table>', copied.html)
  await setDoc(copyRow)
  await select('苹果', 1, 1)
  copied = await copyEvent()
  check('单格内复制仍是文字', /^<p>.*果.*<\/p>$/.test(copied.html) && !/<t[dhr]|<table/.test(copied.html) && !copied.html.includes('苹'), copied.html)
  await mainEval(`(async () => { const { clipboard, ClipboardItem } = ${ELECTRON}; globalThis.__tablesClipboard = await Promise.all((await clipboard.read()).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))) })()`)
  try {
    await select('果 | 12', 0, '果 | 12'.length)
    // 隐藏窗口 execCommand 可静默返回 false；使用应用实际的原生复制入口。
    await mainEval(`${ELECTRON}.BrowserWindow.getAllWindows()[0].webContents.copy()`)
    let system
    for (let attempt = 0; attempt < 30; attempt++) {
      system = await mainEval(`(async () => { const items = await ${ELECTRON}.clipboard.read(); const get = async type => { const item = items.find(item => item.types.includes(type)); return item ? (await item.getType(type)).text() : '' }; return { text: await get('text/plain'), html: await get('text/html') } })()`)
      if (system.text === '果 | 12' && system.html.includes('<td')) break
      await sleep(50)
    }
    check('系统剪贴板拿到原文和一行表格', system.text === '果 | 12' && system.html.includes('<td style="overflow-wrap:anywhere;word-break:normal;text-align:left">果</td><td style="overflow-wrap:anywhere;word-break:normal;text-align:right">12</td>'), JSON.stringify(system))
    await setDoc('正文\n')
    await select('正文', 2)
    await mainEval(`${ELECTRON}.BrowserWindow.getAllWindows()[0].webContents.paste()`)
    await sleep(200)
    check('系统粘贴回编辑器得到原文', await doc() === '正文果 | 12\n', await doc())
  } finally {
    await mainEval(`(async () => { const { clipboard } = ${ELECTRON}; clipboard.clear(); if (globalThis.__tablesClipboard.length) await clipboard.write(globalThis.__tablesClipboard) })()`)
  }
  await setDoc(fixture)

  // 只换字体族、字号不变：列宽和编辑器字宽都要跟着重算，与换一次主题后的结果一致
  const fontWidths = () => evaluate(`({ char: v.defaultCharacterWidth, columns: [...document.querySelectorAll('.cm-md-table-header .cm-md-table-cell')].map(cell => Math.round(cell.getBoundingClientRect().width)) })`)
  const setFont = async (family, size = 16) => { await sendToWindow('editor-font-changed', { family, size }); await sleep(400) }
  await setDoc(`| Header | Note |\n|---|---|\n| ${'i'.repeat(21)} | ${'W'.repeat(21)} |\n`)
  await setFont('Georgia')
  const georgia = await fontWidths()
  await setFont('Menlo')
  const menlo = await fontWidths()
  await setTheme(await evaluate(`localStorage.getItem('colamd-theme') || 'elegant'`))
  await sleep(300)
  const refreshed = await fontWidths()
  check('比例字体的宽字符列更宽，等宽字体两列等宽', georgia.columns[1] > georgia.columns[0] + 2 && Math.abs(menlo.columns[0] - menlo.columns[1]) <= 2, JSON.stringify({ georgia, menlo }))
  check('只换字体族后的布局与重新换主题一致', same(menlo, refreshed), JSON.stringify({ menlo, refreshed }))
  await setFont('', 0)
  await setDoc(fixture)
  await select('苹果')
  await send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 }); await sleep(60)
  await send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 }); await sleep(60)
  await send('Input.insertText', { text: '中文' }); await sleep(100)
  check('中文输入法组合只写入最终文字', (await doc()).includes('中文苹果') && !(await doc()).includes('zhong'), await doc())
  await key('z', MOD)
  check('中文输入可以撤销', await doc() === fixture)

  await select('苹果')
  await paste('甲\t乙\t丙\t丁\n一\t二\t三\t四\n五\t六\t七\t八\n九\t十\t十一\t十二')
  const pasted = await doc()
  check('粘贴表格数据自动扩展行列', pasted.includes('| 甲 | 乙 | 丙 | 丁 |') && pasted.includes('| 九 | 十 | 十一 | 十二 |'))
  check('扩列保留原表头和对齐', pasted.includes('| 名称 | 内容 | 数量 |  |') && pasted.includes('| :--- | :---: | ---: | --- |'))
  await key('z', MOD)
  check('多行多列粘贴一步撤销', await doc() === fixture)
  await evaluate(`(() => { const d = v.state.doc.toString(); v.dispatch({ selection: { anchor: d.indexOf('单元格编辑'), head: d.indexOf('苹果') + 1 } }); v.focus() })()`)
  await paste('x\ty')
  check('选区伸到表格外时不按表格数据展开', !(await doc()).includes('| x | y |') && (await doc()).includes('x\ty'), await doc())
  await key('z', MOD)
  check('伸到表格外的粘贴可撤销', await doc() === fixture, await doc())

  for (const [name, source] of [
    ['无外侧竖线', 'A | B\n--- | ---\nx | y\n'],
    ['缩进表格', '  | A | B |\n  |---|---|\n  | x | y |\n'],
    ['引用中的表格', '> | A | B |\n> |---|---|\n> | x | y |\n'],
    ['列表中的表格', '- | A | B |\n  |---|---|\n  | x | y |\n'],
    ['仅有表头', '| A | B |\n|---|---|\n'],
    ['紧凑表格', '|A|B|\n|---|---|\n|x|y|\n'],
    ['转义竖线', '| A | B |\n|---|---|\n| x | y\\| |\n'],
    ['末尾转义竖线', 'A | B\n--- | ---\nx | y\\|\n'],
  ]) {
    await setDoc(source)
    const original = await doc()
    check(`${name}保持原文和列数`, original === source && await evaluate(`document.querySelector('.cm-md-table-header').querySelectorAll('.cm-md-table-cell').length`) === 2)
    await select(source.includes('x') ? 'x' : 'A')
    await key('Enter', MOD)
    const edited = await doc()
    check(`${name}支持增行`, edited.split('\n').length === source.split('\n').length + 1 && await evaluate(`document.querySelectorAll('.cm-md-table-row').length`) === (source.includes('x') ? 3 : 2))
    await key('z', MOD)
    check(`${name}增行可撤销`, await doc() === original)
    const html = await exportHTML()
    if (name.includes('转义竖线')) check(`${name}显示字面竖线`, html.includes('y|'), html)
    if (source.includes('x')) {
      await select('x')
      await send('Input.imeSetComposition', {text:'zhong', selectionStart:5, selectionEnd:5}); await sleep(60)
      await send('Input.imeSetComposition', {text:'中文', selectionStart:2, selectionEnd:2}); await sleep(60)
      await send('Input.insertText', {text:'中文'}); await sleep(60)
      check(`${name}支持中文输入`, await doc() === source.replace('x', '中文x'), await doc())
      await key('z', MOD)
      check(`${name}中文输入可撤销`, await doc() === source)
    }
    check(`${name}导出保留表格`, html.includes('<table>') && (name !== '引用中的表格' || html.includes('<blockquote><table>')) && (name !== '列表中的表格' || html.includes('<ul><li><table>')))
  }
  const wrapped = '# 多行单元格\n\n| A | B |\n|---|---|\n| first<br>second | last |\n| next | data |\n'
  await setDoc(wrapped)
  await select('first', 2)
  await key('ArrowDown')
  const secondLine = await evaluate('v.state.selection.main.head')
  check('下方向键先移动到格内下一行', secondLine >= wrapped.indexOf('second') && secondLine <= wrapped.indexOf('second') + 6, secondLine)
  await key('ArrowDown')
  const nextRow = await evaluate('v.state.selection.main.head')
  check('格内末行下移进入下一格', nextRow >= wrapped.indexOf('next') && nextRow <= wrapped.indexOf('next') + 4, nextRow)
  await key('ArrowUp')
  const previous = await evaluate('v.state.selection.main.head')
  check('上移进入上一格的最后一行', previous >= wrapped.indexOf('second') && previous <= wrapped.indexOf('second') + 6, previous)
  check('上下移动不改变多行单元格', await doc() === wrapped)
  // 上下浏览跨过分隔，保持正文落点；点击分隔后的输入保护由 adjacentParagraph 覆盖。
  const between = '前文\n\n| A | B |\n|---|---|\n| text | value |\n\n## 后文\n'
  await setDoc(between)
  await select('value', 5)
  await key('ArrowDown')
  const belowTable = await head()
  check('下方向键跨过分隔到后续标题正文', belowTable >= between.indexOf('后文'))
  await type('新')
  check('下移后输入保持表格分隔和标题', await doc() === between.slice(0, belowTable) + '新' + between.slice(belowTable) && await evaluate(`document.querySelectorAll('.cm-md-table-row').length`) === 2, await doc())
  await setDoc(between)
  await select('A', 1)
  await key('ArrowUp')
  const aboveTable = await head()
  check('上方向键跨过分隔到前段正文', aboveTable <= between.indexOf('\n'))
  await type('新')
  check('上移后输入保持表格前分隔', await doc() === between.slice(0, aboveTable) + '新' + between.slice(aboveTable), await doc())
  await setDoc(between)
  await select('value', 5)
  await key('Enter', MOD)
  await key('Enter')
  check('空末行按 Enter 删掉空行', await doc() === between, await doc())
  await type('新')
  check('空末行按 Enter 后输入的是正文', await doc() === between.replace('## 后文', '## 新后文'), await doc())
  await key('z', MOD)
  await key('z', MOD)
  await key('z', MOD)
  check('离开表格的几步都可撤销', await doc() === between, await doc())
  const quoted = '> | A | B |\n> |---|---|\n> | x | y |\n>\n> 引用结尾\n'
  await setDoc(quoted)
  await select('y', 1)
  await key('ArrowDown')
  const afterQuote = await head()
  check('引用表格下移跨过空引用分隔', afterQuote >= quoted.indexOf('引用结尾'))
  await type('新')
  check('引用表格下移输入保留分隔和前缀', await doc() === quoted.slice(0, afterQuote) + '新' + quoted.slice(afterQuote), await doc())
  const spaced = '| A | B |\n|---|---|\n|  | x |\n'
  await setDoc(spaced)
  await clickCell(1, 0)
  await type('空')
  check('只有空格的格子输入后两侧各留一个空格', await doc() === '| A | B |\n|---|---|\n| 空 | x |\n', await doc())
  await key('z', MOD)
  check('空格格子的输入一步撤销', await doc() === spaced, await doc())
  const noNewline = '| A | B |\n|---|---|\n| text | value |'
  await setDoc(noNewline)
  await select('text')
  await key('Enter')
  await key('Enter')
  const paragraphFocused = () => evaluate(`document.activeElement?.classList.contains('cm-md-table-paragraph-input') && document.activeElement.getBoundingClientRect().height > 0`)
  check('删除表格末尾空行后先落到临时正文位置', await doc() === noNewline && await paragraphFocused(), await doc())
  await type('正文')
  check('无结尾换行的表格后也能继续写作', await doc() === noNewline + '\n\n正文', await doc())
  // 文档边界的方向键只创建临时可见落点；首次输入与必要空行是同一笔实际编辑。
  await setDoc(noNewline)
  await sleep(600)
  await select('value', 5)
  await key('ArrowDown')
  check('文末表格按下方向键显示正文光标且不改原文', await doc() === noNewline && await paragraphFocused(), await doc())
  await type('正文')
  check('离开文末表格后输入的是正文', await doc() === noNewline + '\n\n正文' && await evaluate(`document.querySelectorAll('.cm-md-table-row').length`) === 2, await doc())
  await key('z', MOD)
  check('首次正文输入与必要空行一步撤销并恢复表外光标', await doc() === noNewline && await paragraphFocused(), await doc())
  await key('z', MOD | 8)
  check('首次正文输入与必要空行一步重做', await doc() === noNewline + '\n\n正文', await doc())
  await key('z', MOD)
  await type('继续')
  check('表外正文撤销后继续输入仍是正文', await doc() === noNewline + '\n\n继续', await doc())
  await setDoc(noNewline + '\n')
  await sleep(600)
  await select('value', 5)
  await key('ArrowRight')
  check('结尾已有换行时向右离开仍不补空行', await doc() === noNewline + '\n' && await paragraphFocused(), await doc())
  await key('Escape')
  check('取消临时正文落点保持原文并返回表格', await doc() === noNewline + '\n' && !await evaluate(`!!document.querySelector('.cm-md-table-paragraph-input')`) && await head() === noNewline.indexOf('value') + 5, await doc())
  await setDoc(noNewline + '\n')
  await sleep(600)
  await select('A')
  await key('ArrowUp')
  check('文首表格按上方向键只显示临时段落', await doc() === noNewline + '\n' && await paragraphFocused(), await doc())
  await paste('正文\n第二行')
  check('文首临时段落粘贴确认后才创建正文', await doc() === '正文\n第二行\n\n' + noNewline + '\n', await doc())
  await key('z', MOD)
  check('文首正文粘贴及补行一步撤销并恢复表外光标', await doc() === noNewline + '\n' && await paragraphFocused(), await doc())
  await type('文首继续')
  check('文首正文撤销后继续输入不进入表头', await doc() === '文首继续\n\n' + noNewline + '\n', await doc())
  await key('z', MOD)
  await select('value', 5)
  await key('ArrowRight')
  await send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
  check('表外临时段落的输入法预编辑不改文档', await doc() === noNewline + '\n', await doc())
  await send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  check('取消表外输入法预编辑不创建段落', await doc() === noNewline + '\n', await doc())
  await clickCell(1, 0)
  check('点击表格取消临时段落且不改文档', await doc() === noNewline + '\n' && !await evaluate(`!!document.querySelector('.cm-md-table-paragraph-input')`), await doc())
  await select('value', 5)
  await key('ArrowRight')
  await evaluate(`v.setState(v.state)`)
  await sleep(50)
  check('恢复标签状态取消临时段落并返回原单元格', await doc() === noNewline + '\n' && !await evaluate(`!!document.querySelector('.cm-md-table-paragraph-input')`) && await head() === noNewline.indexOf('value') + 5, await doc())
  // 应用的 restoreEditorState 在 setState 后会恢复编辑器焦点。
  await evaluate(`v.focus()`)
  await type('X')
  check('恢复标签状态后继续输入不落入隐藏源码格', await doc() === (noNewline + '\n').replace('value', 'valueX'), await doc())
  await setDoc(noNewline)
  await select('value', 5)
  await key('ArrowDown')
  await evaluate(`document.getElementById('source-toggle-btn').focus()`)
  await sleep(50)
  check('临时段落失焦取消后保留安全格内光标', await doc() === noNewline && !await evaluate(`!!document.querySelector('.cm-md-table-paragraph-input')`) && await head() === noNewline.indexOf('value') + 5, await doc())
  await evaluate(`v.focus()`)
  await type('X')
  check('临时段落失焦后继续输入不落入隐藏源码格', await doc() === noNewline.replace('value', 'valueX'), await doc())
  const longTable = '# 长表格\n\n| A | B |\n|---|---|\n' + Array.from({length:1200}, (_,i)=>`| row-${i} | 内容-${i} |`).join('\n') + '\n'
  await setDoc(longTable)
  await evaluate(`v.scrollDOM.scrollTop=v.scrollDOM.scrollHeight`)
  for (let i=0;i<60 && !await evaluate(`v.contentDOM.textContent.includes('row-1199')`);i++) await sleep(50)
  check('长表格滚动到底部仍然渲染', await evaluate(`v.contentDOM.textContent.includes('row-1199') && !!document.querySelector('.cm-md-table-last .cm-md-table-cell')`))
  check('长表格只渲染视口附近的单元格', await evaluate(`document.querySelectorAll('.cm-md-table-cell').length < 2400`))
  check('长表格虚拟占位保持表格布局', await evaluate(`([...v.contentDOM.querySelectorAll('.cm-md-table-widget:has(> .cm-gap)')]).every(table => getComputedStyle(table).display === 'table')`))
  await evaluate(`v.scrollDOM.scrollTop=0`)
  for (let i=0;i<60 && !await evaluate(`!!document.querySelector('.cm-md-table-header')`);i++) await sleep(50)
  check('长表格往返滚动不改写原文', await doc() === longTable)

  // 内容放得下后均分余量；编辑后固定的列宽不能因访问另一张表而丢失。
  const settleReviewLayout = condition => evaluate(`(async () => {
    let previous = '', stable = 0
    for (let frame = 0; frame < 120; frame++) {
      await new Promise(resolve => requestAnimationFrame(resolve))
      const current = JSON.stringify([...v.contentDOM.querySelectorAll('.cm-md-table-header .cm-md-table-cell')].map(cell => cell.getBoundingClientRect().width))
      stable = (${condition}) && current === previous ? stable + 1 : 0
      if (stable >= 3) return
      previous = current
    }
    throw new Error('布局未在预期视口收敛')
  })()`)
  let reviewTable
  const locateReviewTable = async () => { reviewTable = await evaluate(`'[data-table-id="' + v.contentDOM.querySelector('.cm-md-table-widget:has(.cm-md-table-header)').dataset.tableId + '"]'`) }
  const reviewColumns = () => evaluate(`[...v.contentDOM.querySelectorAll('${reviewTable} .cm-md-table-header .cm-md-table-cell')].map(cell => cell.getBoundingClientRect().width)`)
  await setDoc('| A | B |\n|---|---|\n| [link](https://example.com/`a|b`) | END |\n')
  await locateReviewTable()
  await settleReviewLayout(`v.contentDOM.querySelectorAll('${reviewTable} .cm-md-table-header .cm-md-table-cell').length === 2`)
  const shortColumns = await reviewColumns()
  check('短链接与短文字不会把几像素内容差距放大为悬殊列宽', Math.abs(shortColumns[0] - shortColumns[1]) <= (shortColumns[0] + shortColumns[1]) * 0.025, JSON.stringify(shortColumns))
  const reviewedLayout = '| A | B |\n|---|---|\n| a | ' + 'W'.repeat(60) + ' |\n\n' + '两张表之间的正文。\n\n'.repeat(160) + '| X | Y |\n|---|---|\n| end | end |\n'
  await setDoc(reviewedLayout)
  await locateReviewTable()
  await settleReviewLayout(`v.contentDOM.querySelectorAll('${reviewTable} .cm-md-table-header .cm-md-table-cell').length === 2`)
  const beforeReviewedEdit = await reviewColumns()
  const reviewedCache = await evaluate(`(async () => {
    const first = v.state.doc.toString().indexOf('| a') + 3
    for (let step = 0; step < 120; step++) {
      v.dispatch({ changes: { from: first + step, insert: 'W' }, selection: { anchor: first + step + 1 }, userEvent: 'input.type' })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
    const plugin = v.plugins.map(instance => instance.value).find(value => value?.metrics instanceof Map && value?.layouts instanceof Map)
    return { entries: plugin.metrics.size, keyCharacters: [...plugin.metrics.keys()].reduce((total, key) => total + key.length, 0) }
  })()`)
  const afterReviewedEdit = await reviewColumns()
  check('同格增量输入不累计历史全文度量', reviewedCache.entries <= 4, JSON.stringify(reviewedCache))
  check('增量输入时各列保持初始宽度', beforeReviewedEdit.every((width, column) => Math.abs(width - afterReviewedEdit[column]) < 1), JSON.stringify({ beforeReviewedEdit, afterReviewedEdit }))
  const editedReviewedLayout = await doc()
  await evaluate(`v.dispatch({ selection: { anchor: v.state.doc.length } }); v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight`)
  await settleReviewLayout(`!!v.contentDOM.querySelector('.cm-md-table-row') && !v.contentDOM.querySelector('${reviewTable} .cm-md-table-row')`)
  check('离开视口后保留当前文档表格的列宽CSS', await evaluate(`[...v.dom.querySelectorAll('style')].some(style => style.textContent.includes('${reviewTable} .cm-md-table-cell'))`))
  await evaluate(`v.scrollDOM.scrollTop = 0`)
  await settleReviewLayout(`!!v.contentDOM.querySelector('${reviewTable} .cm-md-table-header')`)
  const returnedReviewedColumns = await reviewColumns()
  check('编辑后访问另一张表再返回保持列宽与原文', afterReviewedEdit.every((width, column) => Math.abs(width - returnedReviewedColumns[column]) < 1) && await doc() === editedReviewedLayout, JSON.stringify({ afterReviewedEdit, returnedReviewedColumns }))

  const openEndedTable = '| A | B |\n|---|---|\n| a | LAST' + 'W'.repeat(60)
  await setDoc(openEndedTable)
  await locateReviewTable()
  await settleReviewLayout(`v.contentDOM.querySelectorAll('${reviewTable} .cm-md-table-header .cm-md-table-cell').length === 2`)
  const openEndedColumns = await reviewColumns()
  await select('a', 1)
  await type('W'.repeat(120))
  await select('LAST' + 'W'.repeat(60), 64)
  await key('ArrowDown')
  const openEndedEdited = await doc()
  check('省略尾竖线的表格也只导航不改文档', openEndedEdited === openEndedTable.replace('| a |', '| a' + 'W'.repeat(120) + ' |') && await paragraphFocused(), openEndedEdited)
  await type('正文')
  await settleReviewLayout(`!!v.contentDOM.querySelector('${reviewTable} .cm-md-table-header')`)
  const openEndedAfter = await reviewColumns()
  check('省略尾竖线时首次表外输入不改变固定列宽', openEndedColumns.every((width, column) => Math.abs(width - openEndedAfter[column]) < 1) && await doc() === openEndedEdited + '\n\n正文', JSON.stringify({ openEndedColumns, openEndedAfter }))

  const scrolling = '| 场景 | 示例 | 备注 |\n|---|---|---|\n| 换行 | 第一行<br>第二行<br>第三行 | 说明 |\n| 长英文 | document_export_configuration_preview | 比较长的备注内容用于分配列宽 |\n\n' + '表格之间的正文。\n\n'.repeat(40)
    + '| 编号 | 地区 | 产品 | 数量 | 金额（元） | 备注 |\n| :---: | :---: | :--- | ---: | ---: | :--- |\n'
    + Array.from({ length: 160 }, (_, i) => `| ${i + 1} | 杭州 | 文档模板 | ${i + 8} | ${(i * 123.45).toFixed(2)} | ${i % 13 ? '可以直接修改' : '这是一段较长的备注，用于检查内容滚出视口时各列是否仍然保持原来的宽度。'} |`).join('\n')
    + '\n\n' + '表格之后的正文。\n\n'.repeat(40)
  for (const theme of themes) {
    await setTheme(theme)
    await setDoc(scrolling)
    const widths = await evaluate(`(async () => {
      const previous = new Map(); let delta = 0, samples = 0
      const sample = () => document.querySelectorAll('#editor .cm-content .cm-md-table-widget').forEach(table => {
        const rect = table.getBoundingClientRect()
        const row = table.querySelector('.cm-md-table-row')
        if (!row || rect.bottom < 36 || rect.top > innerHeight) return
        const current = Array.from(row.querySelectorAll('.cm-md-table-cell')).map(cell => cell.getBoundingClientRect().width)
        const last = previous.get(table.dataset.tableId)
        if (last) current.forEach((width, column) => { delta = Math.max(delta, Math.abs(width - last[column])) })
        previous.set(table.dataset.tableId, current); samples++
      })
      const bottom = v.scrollDOM.scrollHeight - v.scrollDOM.clientHeight
      for (const direction of [1, -1]) for (let offset = 0; offset <= bottom; offset += 280) {
        v.scrollDOM.scrollTop = direction > 0 ? offset : bottom - offset
        sample(); await new Promise(resolve => requestAnimationFrame(resolve)); sample()
      }
      return {delta, samples, tables:previous.size}
    })()`)
    check(`${theme} 表格滚出再滚回视口时列宽稳定`, widths.delta < 1 && widths.tables === 2 && widths.samples > 20, JSON.stringify(widths))
    check(`${theme} 滚动保持源码与虚拟渲染`, await doc() === scrolling && await evaluate(`document.querySelectorAll('#editor .cm-content .cm-md-table-cell').length < 160 * 6`))
  }
  await setDoc(fixture)
  const out = await exportHTML()
  check('HTML 导出为语义表格并保留格式', /<table><thead>/.test(out) && out.includes('<strong>加粗</strong>') && out.includes('<code>代码</code>') && !out.includes('cm-md-table-marker'))
  await evaluate(`document.getElementById('source-toggle-btn').click()`)
  check('源码模式包含原始表格', await evaluate(`document.getElementById('source-editor').value`) === fixture)
  await evaluate(`document.getElementById('source-toggle-btn').click()`)
  check('退出源码模式恢复可编辑表格', await doc() === fixture && await evaluate(`document.querySelectorAll('.cm-md-table-row').length`) === 4)
  await evaluate(`document.body.classList.add('presenting')`)
  check('放映保持表格列布局和页码', await evaluate(`getComputedStyle(document.querySelector('.cm-md-table-header')).display === 'table-row' && document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)').classList.contains('cm-md-page-0')`))
  await evaluate(`document.body.classList.remove('presenting')`)
  await evaluate('window.__colamdPrintExport.enter()')
  check('PDF 直接使用原表格布局且不创建副本', await evaluate(`v.contentDOM.querySelectorAll('.cm-md-table-row').length === 4 && !document.querySelector('.colamd-print-copy')`))
  await evaluate('window.__colamdPrintExport.exit()')
  check('导出不改变原文', await doc() === fixture)
  await sleep(1200)
  const second = join(dir, 'other.md')
  const otherText = '# 另一篇文档\n\n| X | Y |\n|---|---|\n| 独立 | 内容 |\n'
  writeFileSync(second, otherText)
  const originalTime = statSync(file).mtimeMs
  await evaluate(`document.querySelector('.tab-new-btn').click()`); await sleep(150)
  await evaluate(`window.electronAPI.openSibling(${JSON.stringify(second)})`)
  for (let i = 0; i < 50 && !(await doc()).includes('独立'); i++) await sleep(100)
  await select('独立', 2)
  await type('改')
  await sleep(1200)
  check('另一标签的编辑只保存到它自己的文件', readFileSync(second, 'utf8').includes('独立改') && readFileSync(file, 'utf8') === fixture && statSync(file).mtimeMs === originalTime)
  await setFont('Menlo')
  await evaluate(`Array.from(document.querySelectorAll('.tab-entry')).find(tab=>tab.textContent.includes('tables')).click()`)
  await sleep(300)
  const switched = await fontWidths()
  await setTheme(await evaluate(`localStorage.getItem('colamd-theme') || 'elegant'`))
  await sleep(300)
  check('在另一标签换字体后切回，表格按新字体布局', same(switched, await fontWidths()), JSON.stringify({ switched, refreshed: await fontWidths() }))
  await setFont('', 0)
  check('切回原标签保留表格与内容', await doc() === fixture && await evaluate(`document.querySelectorAll('.cm-md-table-row').length`) === 4)
  await key('z', MOD)
  check('撤销不会带入另一标签的内容', !(await doc()).includes('独立改') && readFileSync(second, 'utf8').includes('独立改'))
  await setDoc(fixture)
  check('运行时没有异常', errors.length === 0, JSON.stringify(errors))
  await sleep(1200)
  check('自动保存与缓冲区一致', readFileSync(file, 'utf8') === fixture)
  console.log(`\n${passed} 项表格检查通过`)
  }
} finally {
  ws?.close()
  mainWS?.close()
  child.kill('SIGTERM')
  stopVerifyApp(udd)
}
