// 渲染/源码切换：选区不丢、光标仍可见，位置不会随两种排版的高度差跳走。
// 先 npm run build，再 npm run verify:source-mode。
// --out /path/to/reports --label after 可保留逐项结果；默认不留测试文件。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const root = resolve(option('--root', join(dirname(fileURLToPath(import.meta.url)), '..')))
const out = option('--out', null) ? resolve(option('--out')) : null
const label = option('--label', 'result')
assert(/^[a-zA-Z0-9_-]+$/.test(label), 'label只能含字母、数字、下划线及连字符')
if (out) mkdirSync(out, { recursive: true })

const paragraphs = (count, prefix) => Array.from({ length: count }, (_, i) =>
  `${prefix}${String(i).padStart(3, '0')}：普通正文混合 **加粗**、[可见链接](https://example.com/a/long/hidden/path?x=1) 和中文。${'正文内容和 English words 连续排列，观察切换后的实际光标位置。'.repeat(4)}`).join('\n\n')
const tableRows = Array.from({ length: 1500 }, (_, i) => `| 项目${String(i + 1).padStart(4, '0')} | 第${i + 1}行目标内容 | ${i % 3 ? '短' : '较长说明，自动换行后渲染与源码有不同的高度。'} | ${i * 7} | [链接](https://example.com/${i}) | 完成 |`).join('\n')
const fixture = '# 模式切换视口独立夹具\n\n' + paragraphs(35, '前段') +
  '\n\n## 标题目标：切换时应保留附近的光标\n\n' + paragraphs(12, '中段') +
  '\n\n| 名称 | 说明 |\n|---|---|\n| 普通表格 | **格内目标文字**和[链接标签](https://example.com/hidden) |\n| 第二行 | 内容 |\n\n' +
  paragraphs(12, '表前') + '\n\n| 项目 | 说明 | 备注 | 数值 | 链接 | 状态 |\n|---|---|---|---:|---|---|\n' + tableRows +
  '\n\n长软换行起点：' + '中文连续软换行 word emoji😀 é TAB\t'.repeat(180) + '长软换行终点。\n\n' +
  paragraphs(45, '后段') + '\n'
const fixtureFile = out ? join(out, 'viewport-fixture.md') : null
if (fixtureFile) writeFileSync(fixtureFile, fixture)
const at = (needle, offset = 0) => { const p = fixture.indexOf(needle); assert(p >= 0, needle); return p + offset }
const caret = (name, needle, offset = 0) => ({ name, anchor: at(needle, offset), head: at(needle, offset) })
const scenarios = [
  caret('普通正文', '中段004', 10),
  caret('标题', '标题目标', 8),
  caret('普通表格', '格内目标文字', 3),
  caret('长表格中段', '第746行目标内容', 5),
  caret('长软换行', '长软换行起点', 1900),
  { name: '反向选择', anchor: at('后段010', 12), head: at('后段010', 6) },
  { name: '正向选择', anchor: at('中段008', 6), head: at('中段008', 12) },
  caret('UTF16 emoji后', 'emoji😀', 'emoji😀'.length),
  { name: 'UTF16 组合字符反向选择', anchor: at('emoji😀 é', 'emoji😀 é'.length), head: at('emoji😀', 'emoji😀'.length) },
]
if (args.includes('--fixture-only')) { console.log(JSON.stringify({ fixtureFile, bytes: Buffer.byteLength(fixture), scenarios }, null, 2)); process.exit(0) }

await import(pathToFileURL(join(root, 'scripts/build-freshness.mjs')).href).then(m => m.assertBuildFresh())
const { verifyWorkdir, stopVerifyApp } = await import(pathToFileURL(join(root, 'scripts/verify-workdir.mjs')).href)
const require = createRequire(join(root, 'package.json'))
const { dir: runtime, udd } = verifyWorkdir('source-mode')
const file = join(runtime, 'fixture.md')
writeFileSync(file, fixture)
const originalMtime = statSync(file).mtimeMs
const port = 20600 + Math.floor(Math.random() * 200)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), ['scripts/offscreen-window.cjs', file, '--user-data-dir=' + udd, '--remote-debugging-port=' + port,
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
let launchOutput = '', ws, exitCode = 1
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
child.stdout.on('data', x => { launchOutput += x.toString() }); child.stderr.on('data', x => { launchOutput += x.toString() })
const results = [], failures = [], errors = []
const check = (name, ok, detail) => { results.push({ name, passed: !!ok, detail }); if (!ok) failures.push(name); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ': ' + JSON.stringify(detail)}`) }
const transcript = { root, label, fixtureFile, fixtureBytes: Buffer.byteLength(fixture), results, failures, errors, cases: [] }

try {
  let page
  for (let i = 0; i < 180 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page') } catch {}
    if (!page) await pause(100)
  }
  assert(page, '未启动测试页面：' + JSON.stringify({ exitCode: child.exitCode, launchOutput }))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('调试页面已关闭')) }; pending.clear() })
  ws.addEventListener('message', event => {
    const m = JSON.parse(event.data)
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.description ?? a.value))
    const p = pending.get(m.id); if (!p) return
    pending.delete(m.id); clearTimeout(p.timer)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('CDP请求超时：' + method)) }, 30000)
    pending.set(requestId, { resolve, reject, timer }); ws.send(JSON.stringify({ id: requestId, method, params }))
  })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value
  }
  await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 780, deviceScaleFactor: 1, mobile: false })
  let ready = false
  for (let i = 0; i < 200 && !ready; i++) { ready = await evaluate(`document.querySelector('#editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()===${JSON.stringify(fixture)}`); if (!ready) await pause(100) }
  assert(ready, '编辑器未就绪')
  await evaluate(`window.v = document.querySelector('#editor .cm-content').cmTile.root.view; document.fonts.ready`)
  transcript.frameCadence = await evaluate(`(async()=>{const times=[];for(let i=0;i<4;i++)await new Promise(resolve=>requestAnimationFrame(t=>{times.push(t);resolve()}));return{visibility:document.visibilityState,deltas:times.slice(1).map((t,i)=>t-times[i])}})()`)

  // 与产品实现独立：在测试页复制实际textarea排版，直接量目标字符的Range。
  // 不使用产品source-line helper、逻辑行*行高、滚动比例，也不改变textarea内容。
  await evaluate(`window.viewportProbe = (() => {
    const view = () => document.querySelector('#editor .cm-content').cmTile.root.view
    const source = () => document.getElementById('source-editor')
    function sourceCarets(positions) {
      const el = source(), computed = getComputedStyle(el), mirror = document.createElement('div')
      for (const prop of ['font-family','font-size','font-weight','font-style','font-variant','font-stretch','line-height','letter-spacing','word-spacing','text-align','text-indent','text-transform','tab-size','word-break','overflow-wrap','direction','padding-top','padding-right','padding-bottom','padding-left']) mirror.style.setProperty(prop,computed.getPropertyValue(prop))
      Object.assign(mirror.style,{position:'fixed',left:'0',top:'0',width:el.clientWidth+'px',height:'auto',minHeight:'0',maxHeight:'none',margin:'0',border:'0',boxSizing:'border-box',whiteSpace:el.wrap==='off'?'pre':'pre-wrap',visibility:'hidden',pointerEvents:'none',overflow:'visible'})
      // 单一文本节点保留浏览器原生分词和换行；末尾sentinel让空文档/最后空行有矩形。
      const text = document.createTextNode(el.value+'\\u2060'); mirror.appendChild(text); document.body.appendChild(mirror)
      try {
        const box=el.getBoundingClientRect(),m=mirror.getBoundingClientRect()
        return positions.map(position=>{
          const range = document.createRange(), p = Math.max(0,Math.min(position,el.value.length))
          range.setStart(text,p);range.setEnd(text,p+1)
          const r=range.getBoundingClientRect()
          return {top:box.top+el.clientTop+r.top-m.top-el.scrollTop,bottom:box.top+el.clientTop+r.bottom-m.top-el.scrollTop,left:box.left+el.clientLeft+r.left-m.left-el.scrollLeft,mirrorHeight:mirror.scrollHeight,scrollHeight:el.scrollHeight}
        })
      }finally{mirror.remove()}
    }
    const sourceCaret = position => sourceCarets([position])[0]
    function measure(mode, position) {
      const v=view(),el=mode==='source'?source():v.scrollDOM,box=el.getBoundingClientRect()
      const selection=mode==='source'?{anchor:source().selectionDirection==='backward'?source().selectionEnd:source().selectionStart,head:source().selectionDirection==='backward'?source().selectionStart:source().selectionEnd}: {anchor:v.state.selection.main.anchor,head:v.state.selection.main.head}
      const c=mode==='source'?sourceCaret(selection.head):v.coordsAtPos(selection.head)
      const expected=position===selection.head?c:mode==='source'?sourceCaret(position):v.coordsAtPos(position)
      const top=box.top+el.clientTop,bottom=top+el.clientHeight
      let nativeHead=null
      const native=getSelection()
      if(mode==='render'&&native?.focusNode&&v.contentDOM.contains(native.focusNode))try{nativeHead=v.posAtDOM(native.focusNode,native.focusOffset)}catch{}
      return {mode,selection,nativeHead,activeElement:document.activeElement?.id||document.activeElement?.className||null,expectedPosition:position,expectedCaret:expected?{top:expected.top,bottom:expected.bottom,left:expected.left}:null,focused:mode==='source'?document.activeElement===source():v.hasFocus,scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,viewport:{top,bottom,height:el.clientHeight,width:el.clientWidth},caret:c?{top:c.top,bottom:c.bottom,left:c.left}:null,relativeY:c?((c.top+c.bottom)/2-top)/el.clientHeight:null,visible:!!c&&c.top>=top-1&&c.bottom<=bottom+1,lineHeight:parseFloat(getComputedStyle(el).lineHeight)||24,mirrorHeight:c?.mirrorHeight??null}
    }
    async function settle(mode,position) {
      let last='',stable=0,result
      for(let i=0;i<150;i++) {
        await new Promise(requestAnimationFrame)
        result=measure(mode,position)
        const current=JSON.stringify([result.scrollTop,result.scrollHeight,result.caret,result.viewport])
        if(current===last)stable++;else stable=0
        if(stable>=4)return result
        last=current
      }
      throw new Error('几何未稳定：'+JSON.stringify(result))
    }
    async function place(mode,anchor,head) {
      if(mode==='source') {source().focus({preventScroll:true});source().setSelectionRange(Math.min(anchor,head),Math.max(anchor,head),head<anchor?'backward':'forward')}
      else {view().dispatch({selection:{anchor,head},scrollIntoView:true});view().focus()}
      await settle(mode,head)
      for(let i=0;i<3;i++) {const m=measure(mode,head);if(!m.caret)throw new Error('准备阶段找不到光标');const el=mode==='source'?source():view().scrollDOM;el.scrollTop+=(m.caret.top+m.caret.bottom)/2-m.viewport.top-m.viewport.height*0.37;await settle(mode,head)}
      return measure(mode,head)
    }
    return {measure,settle,place,sourceCarets}
  })()`)
  const mode = () => evaluate(`document.getElementById('source-editor').classList.contains('visible')?'source':'render'`)
  const toggle = async (target, head) => {
    await evaluate(`document.getElementById('source-toggle-btn').click()`)
    assert(await mode() === target, '按钮没有切换到' + target)
    return evaluate(`viewportProbe.settle(${JSON.stringify(target)},${head})`)
  }
  const waitFor = async (expression, message) => {
    const ready = await evaluate(`(async()=>{for(let i=0;i<300;i++){if(${expression})return true;await new Promise(requestAnimationFrame)}return false})()`)
    assert(ready, message)
  }
  const openFixture = async (path, text) => {
    await evaluate(`window.electronAPI.openSibling(${JSON.stringify(path)})`)
    await waitFor(`!document.getElementById('source-editor').classList.contains('visible')&&v.state.doc.toString()===${JSON.stringify(text)}`, '未打开独立夹具')
    await evaluate('viewportProbe.settle("render",v.state.selection.main.head)')
  }
  check('实际文件原文已加载', await evaluate('v.state.doc.toString()') === fixture)
  const runScenario = async (scenario, expected = fixture, nearby = true) => {
    const { name, anchor, head } = scenario
    const item = { name, anchor, head }; transcript.cases.push(item)
    if (await mode() === 'source') await toggle('render', head)
    item.renderBefore = await evaluate(`viewportProbe.place('render',${anchor},${head})`)
    check(name + '准备时渲染光标可见', item.renderBefore.visible, item.renderBefore)
    item.sourceAfter = await toggle('source', head)
    check(name + '渲染→源码原文不变', await evaluate(`document.getElementById('source-editor').value`) === expected)
    check(name + '渲染→源码选区及方向不变', item.sourceAfter.selection.anchor === anchor && item.sourceAfter.selection.head === head, item.sourceAfter.selection)
    check(name + '渲染→源码光标可见且有焦点', item.sourceAfter.visible && item.sourceAfter.focused, item.sourceAfter)
    const sourceDistance = Math.abs(item.sourceAfter.relativeY - item.renderBefore.relativeY) * item.sourceAfter.viewport.height
    if (nearby) check(name + '渲染→源码光标在原纵向附近', Number.isFinite(sourceDistance) && sourceDistance <= Math.max(item.sourceAfter.viewport.height * 0.12, item.sourceAfter.lineHeight * 2), { distance: sourceDistance, before: item.renderBefore.relativeY, after: item.sourceAfter.relativeY })
    check(name + '源码几何oracle覆盖真实换行高度', Math.abs(Math.max(item.sourceAfter.mirrorHeight, item.sourceAfter.viewport.height) - item.sourceAfter.scrollHeight) <= item.sourceAfter.lineHeight + 2, { mirrorHeight: item.sourceAfter.mirrorHeight, scrollHeight: item.sourceAfter.scrollHeight })

    // 独立准备反向测试，避免上一步失败导致的错误视口成为下一步基准。
    item.sourceBefore = await evaluate(`viewportProbe.place('source',${anchor},${head})`)
    check(name + '准备时源码光标可见', item.sourceBefore.visible, item.sourceBefore)
    item.renderAfter = await toggle('render', head)
    check(name + '源码→渲染原文不变', await evaluate('v.state.doc.toString()') === expected)
    check(name + '源码→渲染选区及方向不变', item.renderAfter.selection.anchor === anchor && item.renderAfter.selection.head === head, item.renderAfter.selection)
    check(name + '源码→渲染光标可见且有焦点', item.renderAfter.visible && item.renderAfter.focused, item.renderAfter)
    const renderDistance = Math.abs(item.renderAfter.relativeY - item.sourceBefore.relativeY) * item.renderAfter.viewport.height
    if (nearby) check(name + '源码→渲染光标在原纵向附近', Number.isFinite(renderDistance) && renderDistance <= Math.max(item.renderAfter.viewport.height * 0.12, item.renderAfter.lineHeight * 2), { distance: renderDistance, before: item.sourceBefore.relativeY, after: item.renderAfter.relativeY })
  }
  for (const scenario of scenarios) await runScenario(scenario)

  // 根据独立oracle实测的换行边缘选点，不假定字体、字符宽度或一个逻辑行只有一行。
  const softStart = at('长软换行起点')
  await toggle('source', softStart)
  const candidates = Array.from({ length: 130 }, (_, i) => softStart + i).filter(p => fixture.charCodeAt(p) < 0xdc00 || fixture.charCodeAt(p) > 0xdfff)
  const rects = await evaluate(`viewportProbe.sourceCarets(${JSON.stringify(candidates)})`)
  const wrap = rects.findIndex((r, i) => i > 0 && r.top - rects[i - 1].top > 10)
  assert(wrap > 0, '软换行夹具没有跨越实测换行边缘')
  await runScenario({ name: '软换行边缘前', anchor: candidates[wrap - 1], head: candidates[wrap - 1] })
  await runScenario({ name: '软换行边缘后', anchor: candidates[wrap], head: candidates[wrap] })
  check('仅切换模式不改磁盘字节或mtime', readFileSync(file, 'utf8') === fixture && statSync(file).mtimeMs === originalMtime)

  // 共同入口使用真实鼠标点击现有按钮，每个press/release是独立输入事件，不等布局。
  for (const count of [2, 3]) {
    const scenario = scenarios.find(s => s.name === '反向选择')
    if (await mode() === 'source') await toggle('render', scenario.head)
    const before = await evaluate(`viewportProbe.place('render',${scenario.anchor},${scenario.head})`)
    const box = await evaluate(`(()=>{const r=document.getElementById('source-toggle-btn').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box })
    const observed = []
    for (let i = 0; i < count; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 })
      observed.push(await mode())
    }
    const finalMode = await mode()
    const after = await evaluate(`viewportProbe.settle(${JSON.stringify(finalMode)},${scenario.head})`)
    const later = await evaluate(`(async()=>{for(let i=0;i<8;i++)await new Promise(requestAnimationFrame);return viewportProbe.measure(${JSON.stringify(finalMode)},${scenario.head})})()`)
    transcript.cases.push({ name: `真实鼠标${count}次切换`, route: 'CDP mouse press/release', observed, before, after, later })
    const text = await evaluate(finalMode === 'source' ? `document.getElementById('source-editor').value` : 'v.state.doc.toString()')
    const routeWorks = observed.every((m, i) => m === (i % 2 ? 'render' : 'source'))
    check(`真实鼠标${count}次正确切换模式`, routeWorks, { observed })
    check(`真实鼠标${count}次保留原文及选区方向`, text === fixture && after.selection.anchor === scenario.anchor && after.selection.head === scenario.head, after)
    if (!routeWorks || text !== fixture) {
      writeFileSync(file, fixture)
      throw new Error('真实点击未完成预期，停止后续用例并恢复本轮独立磁盘夹具')
    }
    check(`真实鼠标${count}次光标仍可见`, after.visible && after.focused, after)
    check(`真实鼠标${count}次没有过期滚动`, later.visible && Math.abs(after.scrollTop - later.scrollTop) <= 1, { after, later })
  }

  // 同调用栈连续按钮调用属于强化边界，与上面的消费者键盘路径分别记录。
  for (const count of [2, 3]) {
    const scenario = scenarios.find(s => s.name === '反向选择')
    if (await mode() === 'source') await toggle('render', scenario.head)
    const before = await evaluate(`viewportProbe.place('render',${scenario.anchor},${scenario.head})`)
    await evaluate(`for(let i=0;i<${count};i++)document.getElementById('source-toggle-btn').click()`)
    const finalMode = count % 2 ? 'source' : 'render'
    assert(await mode() === finalMode, '快速切换的最终模式错误')
    const after = await evaluate(`viewportProbe.settle(${JSON.stringify(finalMode)},${scenario.head})`)
    const later = await evaluate(`(async()=>{for(let i=0;i<8;i++)await new Promise(requestAnimationFrame);return viewportProbe.measure(${JSON.stringify(finalMode)},${scenario.head})})()`)
    transcript.cases.push({ name: `同帧${count}次切换`, before, after, later })
    check(`同帧${count}次切换保留原文及选区方向`, await evaluate(finalMode === 'source' ? `document.getElementById('source-editor').value` : 'v.state.doc.toString()') === fixture && after.selection.anchor === scenario.anchor && after.selection.head === scenario.head, after)
    check(`同帧${count}次切换的光标仍可见`, after.visible && after.focused, after)
    check(`同帧${count}次切换没有过期滚动`, later.visible && Math.abs(after.scrollTop - later.scrollTop) <= 1, { after, later })
  }

  const short = '开头😀\n\n\n\n空行后的文字 é\n\n末尾'
  for (const [name, text, position] of [
    ['文首', short, 0],
    ['空段落', short, short.indexOf('\n\n') + 2],
    ['文末', short, short.length],
    ['末尾空行', '正文😀\n\n', '正文😀\n\n'.length],
    ['空文档', '', 0],
  ]) {
    const path = join(runtime, `${name}.md`)
    writeFileSync(path, text)
    const mtime = statSync(path).mtimeMs
    await openFixture(path, text)
    await runScenario({ name, anchor: position, head: position }, text, false)
    check(name + '切换不改磁盘字节或mtime', readFileSync(path, 'utf8') === text && statSync(path).mtimeMs === mtime)
  }

  const separatorText = '开头😀\n\n空行后的文字 é\n\n末尾'
  const separatorFile = join(runtime, 'separator.md')
  writeFileSync(separatorFile, separatorText)
  const separatorMtime = statSync(separatorFile).mtimeMs
  await openFixture(separatorFile, separatorText)
  // 部分组合启用段落间隔排版：两换行的中点是隐藏分隔，须让到相邻可见边界。
  const hiddenSeparator = await evaluate(`!!v.dom.querySelector('.cm-md-paragraph-separator')`)
  await toggle('source', 5)
  const separatorBefore = await evaluate(`viewportProbe.place('source',5,5)`)
  const separatorAfter = await toggle('render', 5)
  const allowed = hiddenSeparator ? [4, 6] : [5]
  transcript.cases.push({ name: '隐藏分隔映射到合法可见边界', hiddenSeparator, separatorBefore, separatorAfter })
  check('分隔位置只映射到合法可见落点', separatorAfter.selection.anchor === separatorAfter.selection.head && allowed.includes(separatorAfter.selection.head) && separatorAfter.visible, { allowed, separatorAfter })
  check('分隔位置模式切换不改原文或文件', await evaluate('v.state.doc.toString()') === separatorText && readFileSync(separatorFile, 'utf8') === separatorText && statSync(separatorFile).mtimeMs === separatorMtime)

  // A的切换尚有布局测量时立即进入已渲染的B；只验目标B不受污染。
  // 源码态标签的独立选区恢复属于另一项行为，未在这里扩大要求。
  await openFixture(file, fixture)
  const tableHead = scenarios.find(s => s.name === '长表格中段').head
  await evaluate(`viewportProbe.place('render',${tableHead},${tableHead})`)
  const tabA = await evaluate(`document.querySelector('.tab-entry.active').dataset.tabId`)
  await evaluate(`document.querySelector('.tab-new-btn').click()`)
  await waitFor(`document.querySelectorAll('.tab-entry').length===2&&document.querySelector('.tab-entry.active').dataset.tabId!==${JSON.stringify(tabA)}&&v.state.doc.toString()===''`, '未建立独立B标签')
  const textB = '# 标签B\n\n' + paragraphs(35, '标签B') + '\n'
  const fileB = join(runtime, 'tab-b.md')
  writeFileSync(fileB, textB)
  const mtimeB = statSync(fileB).mtimeMs
  await openFixture(fileB, textB)
  const tabB = await evaluate(`document.querySelector('.tab-entry.active').dataset.tabId`)
  const headB = textB.indexOf('标签B012') + 10
  const beforeB = await evaluate(`viewportProbe.place('render',${headB},${headB})`)
  await evaluate(`document.querySelector('[data-tab-id="'+${JSON.stringify(tabA)}+'"]').click()`)
  await waitFor(`document.querySelector('.tab-entry.active').dataset.tabId===${JSON.stringify(tabA)}&&v.state.doc.toString()===${JSON.stringify(fixture)}`, '未返回A标签')
  await evaluate(`viewportProbe.settle('render',${tableHead})`)
  await toggle('source', tableHead)
  await evaluate(`document.getElementById('source-toggle-btn').click();document.querySelector('[data-tab-id="'+${JSON.stringify(tabB)}+'"]').click()`)
  await waitFor(`document.querySelector('.tab-entry.active').dataset.tabId===${JSON.stringify(tabB)}&&v.state.doc.toString()===${JSON.stringify(textB)}`, '快速切换后未进入B标签')
  const afterB = await evaluate(`viewportProbe.settle('render',${headB})`)
  const laterB = await evaluate(`(async()=>{for(let i=0;i<8;i++)await new Promise(requestAnimationFrame);return viewportProbe.measure('render',${headB})})()`)
  transcript.cases.push({ name: '切换标签不污染目标', beforeB, afterB, laterB })
  check('切换模式后立即换标签保留B的原文与选区', await evaluate('v.state.doc.toString()') === textB && afterB.selection.anchor === headB && afterB.selection.head === headB, afterB)
  // 跨文档重测可能修正屏外行高估算；应保持内容锚点，而非旧的绝对scrollTop。
  check('A的待处理滚动不移动B的内容锚点', afterB.visible && laterB.visible &&
    Math.abs(beforeB.relativeY - afterB.relativeY) * afterB.viewport.height <= afterB.viewport.height * 0.12 &&
    Math.abs(afterB.caret.top - laterB.caret.top) <= 1, { beforeB, afterB, laterB })
  check('快速切换标签不改两个文件', readFileSync(file, 'utf8') === fixture && statSync(file).mtimeMs === originalMtime && readFileSync(fileB, 'utf8') === textB && statSync(fileB).mtimeMs === mtimeB)

  await evaluate(`document.querySelector('[data-tab-id="'+${JSON.stringify(tabA)}+'"]').click()`)
  await waitFor(`document.querySelector('.tab-entry.active').dataset.tabId===${JSON.stringify(tabA)}&&v.state.doc.toString()===${JSON.stringify(fixture)}`, '未回到输入测试标签')
  const editHead = scenarios[0].head
  await evaluate(`viewportProbe.place('render',${editHead},${editHead})`)
  await toggle('source', editHead)
  const inserted = '编辑😀\n新段落'
  const edited = fixture.slice(0, editHead) + inserted + fixture.slice(editHead)
  await send('Input.insertText', { text: inserted })
  const newHead = editHead + inserted.length
  const editBefore = await evaluate(`viewportProbe.settle('source',${newHead})`)
  check('源码真实输入保留UTF16光标偏移', await evaluate(`document.getElementById('source-editor').value`) === edited && editBefore.selection.anchor === newHead && editBefore.selection.head === newHead, editBefore)
  const editAfter = await toggle('render', newHead)
  transcript.cases.push({ name: '源码真实编辑后切回', editBefore, editAfter })
  check('源码编辑后切回保留新内容及光标', await evaluate('v.state.doc.toString()') === edited && editAfter.selection.anchor === newHead && editAfter.selection.head === newHead, editAfter)
  check('源码编辑后切回光标仍在附近', editAfter.visible && editAfter.focused && Math.abs(editAfter.relativeY - editBefore.relativeY) * editAfter.viewport.height <= editAfter.viewport.height * 0.12, { editBefore, editAfter })
  const editBack = await toggle('source', newHead)
  check('编辑后再次切源码保留新内容与可见光标', await evaluate(`document.getElementById('source-editor').value`) === edited && editBack.selection.anchor === newHead && editBack.selection.head === newHead && editBack.visible, editBack)

  // 空格子由格里的临时输入框接收输入。切回渲染后焦点若停在编辑器本体，光标会撑满整格，
  // 打的字落进下一行。缺省格在源码里只有行尾一个位置，切回后落在第一个缺省格。
  const tableText = '| 编号 | 名称 | 备注 |\n|---|---|---|\n| 0008 | 团队订阅 |  |\n| 0009 | 笔记本 | 常规订单。 |\n| 缺省 |\n'
  const tableFile = join(runtime, 'empty-cell.md')
  writeFileSync(tableFile, tableText)
  await openFixture(tableFile, tableText)
  const clickCell = async (row, column) => {
    const box = await evaluate(`(()=>{const r=document.querySelectorAll('.cm-md-table-row')[${row}].querySelectorAll('.cm-md-table-cell')[${column}].getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...box, button: 'left', clickCount: 1 })
  }
  const cellFocused = (row, column) => `(()=>{const a=document.activeElement;return a.classList.contains('cm-md-table-input')&&a.closest('.cm-md-table-row').dataset.tableRow==='${row}'&&a.closest('.cm-md-table-cell').dataset.column==='${column}'&&getComputedStyle(document.querySelector('.cm-cursorLayer')).display==='none'})()`
  const roundTrip = async (name, row, column, landing) => {
    await clickCell(row, column)
    await waitFor(cellFocused(row, column), name + '点击后未进入格内输入')
    const head = await evaluate('v.state.selection.main.head')
    await toggle('source', head)
    check(name + '渲染→源码光标在格子位置', await evaluate(`document.getElementById('source-editor').selectionStart`) === head)
    const back = await toggle('render', head)
    const ready = await evaluate(`(async()=>{for(let i=0;i<60;i++){if(${cellFocused(row, landing)})return true;await new Promise(resolve => setTimeout(resolve, 16))}return false})()`)
    const caret = await evaluate(`(()=>{const cell=document.querySelectorAll('.cm-md-table-row')[${row}].querySelectorAll('.cm-md-table-cell')[${landing}],c=v.coordsAtPos(v.state.selection.main.head,v.state.selection.main.assoc||1);return{height:c&&c.bottom-c.top,input:cell.querySelector('.cm-md-table-input').getBoundingClientRect().height,cell:cell.getBoundingClientRect().height}})()`)
    transcript.cases.push({ name, back, caret })
    check(name + '源码往返后由格内输入框接住焦点', ready && back.selection.head === head, { active: await evaluate('document.activeElement.className'), back })
    // 缺省格挤在行尾同一个位置，没有单独的光标几何；只有真实空格子有
    if (column === landing && row !== 3) check(name + '源码往返后光标高度是一行而不是整格', caret.height > 0 && caret.height <= caret.input + 1, caret)
  }
  await roundTrip('空格子', 1, 2, 2)
  await send('Input.insertText', { text: 'Z' })
  await waitFor(`v.state.doc.toString()!==${JSON.stringify(tableText)}`, '空格子输入没有写入')
  const typedEmpty = (await evaluate('v.state.doc.toString()')).split('\n')
  check('空格子源码往返后输入写进原格', /^\| 0008 \| 团队订阅 \|\s*Z\s*\|$/.test(typedEmpty[2]) && typedEmpty[3] === '| 0009 | 笔记本 | 常规订单。 |', typedEmpty)
  await roundTrip('第二个缺省格', 3, 2, 1)
  await roundTrip('第一个缺省格', 3, 1, 1)
  await send('Input.insertText', { text: 'Y' })
  await waitFor(`/缺省 \\|\\s*Y/.test(v.state.doc.toString())`, '缺省格输入没有写入')
  const typedMissing = (await evaluate('v.state.doc.toString()')).split('\n')
  check('缺省格源码往返后输入补齐整行', typedMissing[4] === '| 缺省 | Y |  |' && typedMissing.length === tableText.split('\n').length, typedMissing)

  // 源码位置按真实排版测量，代价随光标前的文字线性增长。用接近整篇源码阈值
  // （512K 字符）的文档记录切换耗时，防止退化成多次全文排版。
  let large = '', index = 0
  while (large.length < 500 * 1024) large += `长文${index++}：普通正文混合 **加粗** 和 [链接](https://example.com/${index})。${'正文内容和 English words 连续排列，记录切换耗时。'.repeat(6)}\n\n`
  const largeFile = join(runtime, 'large.md')
  writeFileSync(largeFile, large)
  await openFixture(largeFile, large)
  const timing = {}
  for (const [name, position] of [['文首', 10], ['文末', large.length - 10]]) {
    await evaluate(`viewportProbe.place('render',${position},${position})`)
    const runs = []
    for (let i = 0; i < 3; i++) {
      const toSource = await evaluate(`(()=>{const t=performance.now();document.getElementById('source-toggle-btn').click();return performance.now()-t})()`)
      await evaluate(`viewportProbe.settle('source',${position})`)
      const toRender = await evaluate(`(()=>{const t=performance.now();document.getElementById('source-toggle-btn').click();return performance.now()-t})()`)
      await evaluate(`viewportProbe.settle('render',${position})`)
      runs.push({ toSource, toRender })
    }
    const median = key => runs.map(r => r[key]).sort((a, b) => a - b)[1]
    timing[name] = { runs, toSource: median('toSource'), toRender: median('toRender') }
  }
  transcript.performance = { characters: large.length, bytes: Buffer.byteLength(large), timing }
  console.log('切换耗时（毫秒，中位数）', JSON.stringify(Object.fromEntries(Object.entries(timing).map(([k, t]) => [k, [Math.round(t.toSource), Math.round(t.toRender)]]))))
  check('接近阈值的长文切换在文末仍在一次排版的量级', timing['文末'].toSource < 600 && timing['文末'].toRender < 600, timing)
  check('运行没有编辑器异常', errors.length === 0, errors)
  exitCode = failures.length ? 1 : 0
} catch (error) {
  transcript.harnessError = error.stack ?? String(error)
  console.error(transcript.harnessError)
} finally {
  transcript.passed = results.filter(r => r.passed).length
  transcript.failed = failures.length
  transcript.exitCode = exitCode
  if (launchOutput) transcript.launchOutput = launchOutput
  if (ws) ws.close()
  stopVerifyApp(udd)
  if (child.exitCode === null) child.kill('SIGTERM')
  if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(2000)])
  if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(runtime, { recursive: true, force: true })
  const report = out ? join(out, `${label}.json`) : null
  if (report) writeFileSync(report, JSON.stringify(transcript, null, 2) + '\n')
  console.log(JSON.stringify({ passed: transcript.passed, failed: transcript.failed, exitCode, report }))
}
process.exitCode = exitCode
