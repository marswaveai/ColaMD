#!/usr/bin/env node
// 先 npm run build，再 npx electron scripts/verify-copy-markdown.cjs。
// 复制给 Markdown 去处的原文：被选区切开的结构补上标记，整段在里面的块不带出来（见 copy-markdown.ts）。
// 使用真正的 Electron 窗口和系统复制、粘贴；窗口由 offscreen-window.cjs 隐藏。
const { app, clipboard, ClipboardItem } = require('electron')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = process.argv.find(arg => arg.startsWith('--report='))?.slice(9)
const checks = []
let savedClipboard = []
let finishing = false

async function main() {
  const { assertBuildFresh } = await import('./build-freshness.mjs')
  const { verifyWorkdir } = await import('./verify-workdir.mjs')
  assertBuildFresh()
  const { dir, udd } = verifyWorkdir('copy-markdown')
  const source = join(dir, 'source.md')
  const destination = join(dir, 'destination.md')
  const initial = '### 复制验收标题\n\n后续正文\n'
  const target = '粘贴目标\n\n'
  writeFileSync(source, initial)
  writeFileSync(destination, target)
  for (const name of ['home', 'userData', 'sessionData']) {
    const path = name === 'userData' ? udd : join(dir, name)
    mkdirSync(path, { recursive: true })
    app.setPath(name, path)
  }
  process.argv = [process.argv[0], __filename, source]
  await app.whenReady()
  savedClipboard = await Promise.all((await clipboard.read()).map(async item => new ClipboardItem(
    Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))),
  )))
  let started = false
  app.on('browser-window-created', (_event, win) => {
    if (started) return
    started = true
    win.webContents.once('did-finish-load', () => run(win, { source, destination, initial, target }).then(
      () => finish(0), error => { console.error(error); finish(1) },
    ))
  })
  require('./offscreen-window.cjs')
}

async function finish(code) {
  if (finishing) return
  finishing = true
  if (report) writeFileSync(report, JSON.stringify({ checks, passed: checks.filter(c => c.ok).length, code }, null, 2))
  clipboard.clear()
  try {
    if (savedClipboard.length) await clipboard.write(savedClipboard)
  } finally {
    console.log(`复制原文验收：${checks.filter(c => c.ok).length}/${checks.length} 通过`)
    app.exit(code)
  }
}

async function run(win, files) {
  const ev = expression => win.webContents.executeJavaScript(expression)
  const check = (name, fn) => {
    try { fn(); checks.push({ name, ok: true }) }
    catch (error) { checks.push({ name, ok: false, error: error.message }); console.error(`失败：${name}\n${error.message}`) }
  }
  const key = async (keyCode, modifiers = []) => {
    const command = { c: 'copy', v: 'paste', x: 'cut' }[keyCode]
    if (command) {
      if (command === 'copy' || command === 'cut') await clipboard.writeText('标题复制验收占位')
      win.webContents[command]()
    }
    else await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key:${JSON.stringify(keyCode)},code:${JSON.stringify('Key' + keyCode.toUpperCase())},
      metaKey:${modifiers.includes('meta')},ctrlKey:${modifiers.includes('control')},
      shiftKey:${modifiers.includes('shift')},bubbles:true,cancelable:true
    }))`)
    await delay(50)
  }
  const mod = process.platform === 'darwin' ? 'meta' : 'control'
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let i = 0; i < 100; i++) {
    if (await ev(`document.querySelector('.cm-content')?.textContent.includes('复制验收标题')`)) break
    await delay(100)
  }
  await ev(`window.v = document.querySelector('.cm-content').cmTile.root.view; undefined`)
  assert.equal(await ev('v.state.doc.toString()'), files.initial, '临时夹具必须加载成功')
  const reset = async (doc, from, to, reverse = false) => {
    await ev(`(() => {
      v.setState(v.state.constructor.create({doc:${JSON.stringify(doc)},extensions:v.state.config.base}));
      v.dispatch({selection:{anchor:${reverse ? to : from},head:${reverse ? from : to}}});v.focus()
    })()`)
    await delay(25)
  }
  const copy = () => ev(`(() => {
    const before = v.state.doc.toString(), selection = v.state.selection.toJSON();
    const data = new DataTransfer();
    v.contentDOM.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));
    return {text:data.getData('text/plain'),html:data.getData('text/html'),
      unchanged:before===v.state.doc.toString()&&JSON.stringify(selection)===JSON.stringify(v.state.selection.toJSON())}
  })()`)
  const sample = async (name, doc, from, to, expected, level, reverse = false) => {
    await reset(doc, from, to, reverse)
    const copied = await copy()
    check(name, () => {
      assert.equal(copied.text, expected)
      assert.ok(copied.unchanged, '复制不能修改文档或选区')
      if (level) assert.ok(copied.html.includes(`<h${level}>`), copied.html)
    })
  }

  for (let level = 1; level <= 6; level++) {
    const prefix = '#'.repeat(level) + ' '
    const title = `级别${level}标题`
    const doc = `${prefix}${title}\n\n后续正文\n\n## 另一个标题\n末尾`
    const from = prefix.length, end = from + title.length, to = doc.indexOf('后续正文') + 4
    await sample(`H${level} 单独选完整标题按文字复制`, doc, from, end, title)
    const titleOnly = await copy()
    check(`H${level} 单独选字不带标题 HTML`, () => assert.ok(!/<h[1-6](?:>|\s)/.test(titleOnly.html), titleOnly.html))
    await sample(`H${level} 单独选部分文字`, doc, from + 1, end - 1, title.slice(1, -1))
    await sample(`H${level} 跨块正向复制`, doc, from, to, doc.slice(0, to), level)
    await sample(`H${level} 跨块反向复制`, doc, from, to, doc.slice(0, to), level, true)
    await sample(`H${level} 从标题中间跨块保留级别但不补前文`, doc, from + 1, to, prefix + doc.slice(from + 1, to), level)
    await sample(`H${level} 从标题中间反向跨块保留级别`, doc, from + 1, to, prefix + doc.slice(from + 1, to), level, true)
    await sample(`H${level} 源码行首起选不重复标记`, doc, 0, to, doc.slice(0, to), level)
    await sample(`H${level} 从标记中间起选补完整前缀`, doc, 1, to, doc.slice(0, to), level)
    await sample(`H${level} 选中标题后换行`, doc, from, end + 1, doc.slice(0, end + 1), level)
    await sample(`H${level} 反向选中标题后换行`, doc, from, end + 1, doc.slice(0, end + 1), level, true)
    await sample(`H${level} 选中标题后两个换行`, doc, from, end + 2, doc.slice(0, end + 2), level)
    await sample(`H${level} 反向选中标题后两个换行`, doc, from, end + 2, doc.slice(0, end + 2), level, true)
    await sample(`H${level} 连续跨多个标题`, doc, from, doc.length, doc, level)
    // 用户在同一文件粘贴后，原始 Markdown 层级要完整，且一笔撤销/重做。
    await reset(doc, from, to)
    await key('c', [mod])
    const nativeText = await clipboard.readText()
    const items = await clipboard.read()
    const nativeHTML = items[0]?.types.includes('text/html') ? await (await items[0].getType('text/html')).text() : ''
    check(`H${level} 系统剪贴板包含 Markdown 与标题 HTML`, () => {
      assert.equal(nativeText, doc.slice(0, to))
      assert.ok(nativeHTML.includes(`<h${level}>`), nativeHTML)
    })
    await ev(`v.dispatch({selection:{anchor:v.state.doc.length}});v.focus()`)
    await key('v', [mod])
    const pasted = await ev('v.state.doc.toString()')
    check(`H${level} 粘贴源码完整`, () => assert.equal(pasted, doc + nativeText))
    await key('z', [mod])
    const undone = await ev('v.state.doc.toString()')
    check(`H${level} 撤销还原原文`, () => assert.equal(undone, doc))
    await key('z', [mod, 'shift'])
    const redone = await ev('v.state.doc.toString()')
    check(`H${level} 重做还原粘贴`, () => assert.equal(redone, pasted))
  }

  const special = [
    ['加粗', '### **加粗标题**', '加粗标题', 3],
    ['嵌套强调', '#### ***强调标题***', '强调标题', 4],
    ['删除线', '## ~~删除标题~~', '删除标题', 2],
    ['行内代码', '##### `代码标题`', '代码标题', 5],
    ['链接', '### [链接标题](https://example.com)', '链接标题', 3],
    ['高亮', '### ==高亮标题==', '高亮标题', 3],
    ['高亮嵌套加粗', '### ==**强调高亮**==', '强调高亮', 3],
    ['带结束标记', '### 末尾标记 ###', '末尾标记', 3],
    ['缩进三个空格', '   ## 缩进标题', '缩进标题', 2],
    ['多个分隔空格', '##   空格标题', '空格标题', 2],
    ['引用', '> ### 引用标题', '引用标题', 3],
    ['嵌套引用', '> > #### 嵌套标题', '嵌套标题', 4],
    ['无序列表', '- ### 列表标题', '列表标题', 3],
    ['有序列表', '3. ## 有序标题', '有序标题', 2],
    ['前有正文', '前置正文\n\n### 文中标题', '文中标题', 3],
    ['混合格式', '## **粗体** 与 *斜体*', '粗体', 2],
  ]
  // 从格式文字中间跨块起选：保留块前缀与行内格式，但不带未选中的正文。
  for (const [name, heading, title, level] of special) {
    const doc = `${heading}\n\n后续正文`, from = doc.indexOf(title)
    const lineStart = doc.lastIndexOf('\n', from) + 1
    await sample(`${name} 跨块补齐原始前缀`, doc, from, doc.length, doc.slice(lineStart), level)
    const expected = doc.slice(lineStart, from) + doc.slice(from + 1)
    await sample(`${name} 从正文中间跨块保留标题级别`, doc, from + 1, doc.length, expected, level)
  }
  for (const [name, doc, text] of [
    ['缩进代码', '    ### 缩进代码\n    正文', '缩进代码'],
    ['转义井号', '\\### 转义标题\n\n正文', '转义标题'],
    ['七个井号', '####### 非标题\n\n正文', '非标题'],
    ['井号后无空格', '###不是标题\n\n正文', '不是标题'],
    ['解析器不识别 Tab 标题', '##\t制表文字\n\n正文', '制表文字'],
    ['Setext 一级', '下划线标题\n===\n\n正文', '下划线标题'],
    ['Setext 二级', '下划线标题\n---\n\n正文', '下划线标题'],
    ['属性区', '---\ntitle: 属性\n### YAML文字\n---\n\n正文', 'YAML文字'],
    ['普通正文', '正文文字\n\n### 后面的标题', '文字'],
  ]) await sample(`${name} 不补不存在的标题前缀`, doc, doc.indexOf(text), doc.length, doc.slice(doc.indexOf(text)))

  // ⟦ ⟧ 标出选区在原文里的两端。端点故意放在隐藏标记的里侧或外侧，两种都要得到同样的结果。
  const pick = src => {
    const from = src.indexOf('⟦'), plain = src.replace('⟦', ''), to = plain.indexOf('⟧')
    return { doc: plain.replace('⟧', ''), from, to }
  }
  const matrix = [
    // 行内格式：选区停在定界符里侧也要带上完整的一对
    ['高亮里侧', '正文 ==⟦高亮⟧== 结尾', '==高亮==', '<mark>'],
    ['高亮外侧', '正文 ⟦==高亮==⟧ 结尾', '==高亮==', '<mark>'],
    ['高亮左半在外', '正文 ⟦==高亮⟧== 结尾', '==高亮==', '<mark>'],
    ['高亮切开', '正文 ==高⟦亮==后⟧文', '==亮==后', '<mark>'],
    ['加粗中间', '**加⟦粗文⟧字**', '**粗文**', '<strong>'],
    ['加粗开头', '**⟦加粗**后⟧文', '**加粗**后', '<strong>'],
    ['结束在加粗开标记后', '前⟦文**⟧加粗**', '文'],
    ['开始在加粗闭标记前', '**加粗⟦**后⟧文', '后'],
    ['下划线斜体', '_⟦斜体⟧_ 正文', '_斜体_', '<em>'],
    ['粗斜体', '***⟦粗斜⟧***', '***粗斜***'],
    ['删除线', '~~⟦删除⟧~~', '~~删除~~', '<s>'],
    ['行内代码切开', '`co⟦d⟧e`', '`d`', '<code>'],
    ['链接文字', '见[⟦链接⟧](https://a.com)后', '[链接](https://a.com)'],
    ['链接切开', '[链⟦接文⟧字](https://a.com "题")', '[接文](https://a.com "题")'],
    ['链接里的加粗', '[**⟦粗链⟧**](https://a.com)', '[**粗链**](https://a.com)'],
    ['加粗里的链接', '**[⟦链接](https://a.com)尾⟧巴**', '**[链接](https://a.com)尾**'],
    ['高亮嵌套加粗切开', '==**强⟦调高⟧亮**==', '==**调高**=='],
    ['样式标签', '<span style="color:red">⟦红字⟧</span>', '<span style="color:red">红字</span>'],
    ['跨行带格式', '前文 **加⟦粗\n下一段** 尾⟧', '**粗\n下一段** 尾', '<strong>'],
    // 标题里只选文字：不带 #，行内格式照带
    ['标题里的高亮', '### ==⟦高亮标题⟧==', '==高亮标题=='],
    ['标题里的加粗开头', '## **⟦加粗**标题⟧', '**加粗**标题'],
    ['标题里的链接开头', '### [⟦链接](https://a.com)标题⟧', '[链接](https://a.com)标题'],
    ['从行首选整行标题', '⟦### 标题⟧\n\n正文', '标题'],
    ['带结束标记只选文字', '### ⟦末尾⟧ ###', '末尾'],
    ['带结束标记选到行尾', '### ⟦末尾 ###⟧', '末尾'],
    ['带结束标记跨块', '### ⟦末尾 ###\n\n正文⟧', '### 末尾 ###\n\n正文'],
    ['加粗标题后换行', '### ⟦**加粗标题**\n⟧\n正文', '### **加粗标题**\n', ['<h3>', '<strong>加粗标题</strong>']],
    ['链接标题后换行', '### ⟦[链接标题](https://example.com)\n⟧\n正文', '### [链接标题](https://example.com)\n', ['<h3>', '<a href="https://example.com">']],
    ['颜色标题后换行', '### ⟦<span style="color:#ff0000">颜色标题</span>\n⟧\n正文', '### <span style="color:#ff0000">颜色标题</span>\n', ['<h3>', 'color:']],
    ['标题中间到换行不补未选文字', '### 未选⟦标题\n⟧\n正文', '### 标题\n', ['<h3>标题</h3>', '!未选']],
    // 列表：跨项保留结构，只在一项里选只给文字
    ['无序列表跨项', '- ⟦苹果\n- 香蕉\n- 橙子⟧', '- 苹果\n- 香蕉\n- 橙子', '<ul>'],
    ['无序列表一项', '- ⟦苹果⟧\n- 香蕉', '苹果', ['<p>苹果</p>']],
    ['有序列表跨项', '1. ⟦一\n2. 二⟧', '1. 一\n2. 二', ['<ol><li>一</li><li>二</li></ol>']],
    ['有序列表从三起', '3. ⟦三\n4. 四⟧', '3. 三\n4. 四', ['<ol start="3"><li>三</li><li>四</li></ol>']],
    ['待办跨项', '- [ ] ⟦待办一\n- [x] 待办二⟧', '- [ ] 待办一\n- [x] 待办二'],
    ['待办一项', '- [ ] ⟦待办⟧', '待办'],
    ['列表项中间起选', '- 苹⟦果\n- 香蕉⟧', '- 果\n- 香蕉', '<ul>'],
    ['标题中间跨块', '### 示例⟦标题\n\n后面的正文⟧', '### 标题\n\n后面的正文', '<h3>标题</h3>'],
    ['有序列表中间跨项', '3. 苹⟦果\n4. 香蕉⟧', '3. 果\n4. 香蕉', '<ol start="3">'],
    ['待办中间跨项', '- [x] 苹⟦果\n- [ ] 香蕉⟧', '- [x] 果\n- [ ] 香蕉'],
    ['嵌套列表中间跨项', '- 甲\n  - 香⟦蕉\n  - 橙子⟧', '- 蕉\n- 橙子'],
    ['引用中间跨出', '> 引用⟦文字\n\n正文⟧', '> 文字\n\n正文', '<blockquote>'],
    ['引用内标题中间跨块', '> ### 示例⟦标题\n> 正文⟧', '### 标题\n正文', ['!<blockquote>', '<h3>标题</h3>']],
    ['带结束标记中间跨块', '### 示例⟦标题 ###\n\n正文⟧', '### 标题 ###\n\n正文'],
    ['列表项内续行', '- ⟦甲\n  续行⟧', '甲\n续行', ['!<li>']],
    ['续行跨到下一项', '- ⟦甲\n  续行\n- 乙⟧', '- 甲\n  续行\n- 乙', ['<ul><li>甲<br>续行</li><li>乙</li></ul>']],
    ['嵌套列表跨项', '- 甲\n  - ⟦乙\n  - 丙⟧', '- 乙\n- 丙', ['<ul><li>乙</li><li>丙</li></ul>']],
    ['结束在下一项的标记里', '- ⟦甲\n- ⟧乙', '- 甲\n'],
    ['列表项开头是加粗', '- **⟦苹果**\n- 香蕉⟧', '- **苹果**\n- 香蕉'],
    // 引用：整段在引用里不带 >，跨出去保留
    ['引用里两行', '> ⟦第一行\n> 第二行⟧', '第一行\n第二行', ['!<blockquote>']],
    ['引用里两段', '> ⟦第一段\n>\n> 第二段⟧', '第一段\n\n第二段', ['!<blockquote>', '<p>第一段</p><p>第二段</p>']],
    ['引用跨出', '> ⟦引用\n\n正文⟧', '> 引用\n\n正文', ['<blockquote><p>引用</p></blockquote><p>正文</p>']],
    ['从正文跨进引用', '⟦正文\n\n> 引用⟧', '正文\n\n> 引用'],
    ['引用里的列表跨项', '> - ⟦甲\n> - 乙⟧', '- 甲\n- 乙', ['!<blockquote>', '<ul><li>甲</li><li>乙</li></ul>']],
    ['引用里的列表跨出', '> - ⟦甲\n> - 乙\n\n正文⟧', '> - 甲\n> - 乙\n\n正文', ['<blockquote><ul><li>甲</li><li>乙</li></ul></blockquote><p>正文</p>']],
    ['嵌套引用里', '> > ⟦内一\n> > 内二⟧', '内一\n内二'],
    ['引用里的标题跨块', '> ### ⟦引用标题\n> 正文⟧', '### 引用标题\n正文', ['!<blockquote>', '<h3>引用标题</h3><p>正文</p>']],
    // 代码块：在里面只给代码，跨出去补齐围栏
    ['代码块里多行', '```js\n⟦const a = 1\nconst b = 2⟧\n```', 'const a = 1\nconst b = 2', ['<pre><code>const a = 1\nconst b = 2</code></pre>']],
    ['代码块里半行', '```js\ncon⟦st⟧ a\n```', 'st'],
    ['代码块里的井号', '```md\n⟦### 代码标题⟧\n```', '### 代码标题'],
    ['从代码中间跨出', '```js\nconst ⟦a = 1\n```\n\n正文⟧', '```js\na = 1\n```\n\n正文', '<pre>'],
    ['从代码行首跨出', '```js\n⟦a\nb\n```\n\n正文⟧', '```js\na\nb\n```\n\n正文'],
    ['从外面选进代码中间', '⟦正文\n\n```js\na = ⟧1\n```', '正文\n\n```js\na = \n```'],
    ['从外面选到代码行首', '⟦正文\n\n```js\na\n⟧b\n```', '正文\n\n```js\na\n```'],
    ['选进代码的围栏行', '⟦正文\n\n```js⟧\na\n```', '正文\n\n', ['!<pre>']],
    ['选进收尾围栏', '⟦正文\n\n```js\na\n``⟧`', '正文\n\n```js\na\n```'],
    ['波浪围栏', '~~~~py\n⟦x\n~~~~\n\n尾⟧', '~~~~py\nx\n~~~~\n\n尾'],
    ['未闭合围栏', '⟦正文\n\n```\na⟧\nb', '正文\n\n```\na\n```'],
    ['引用里的代码', '> ```js\n> ⟦a\n> b⟧\n> ```', 'a\nb'],
    ['引用里的代码跨出', '> ```js\n> a⟦b\n> ```\n\n正文⟧', '> ```js\n> b\n> ```\n\n正文', ['<blockquote><pre><code>b</code></pre></blockquote><p>正文</p>']],
    ['列表里的代码', '- 项\n\n  ```js\n  ⟦a\n  b⟧\n  ```', 'a\nb'],
    ['两段代码之间', '```js\na⟦1\n```\n\n中间\n\n```py\nb⟧2\n```', '```js\n1\n```\n\n中间\n\n```py\nb\n```'],
    // 不该动的
    ['普通段落', '一段⟦正文\n第二⟧行', '正文\n第二'],
    ['引用链接方括号可见', '[⟦引用⟧][r]\n\n[r]: https://a.com', '引用'],
    ['只选了隐藏标记', '正文⟦==⟧高亮==', '=='],
  ]
  for (const [name, src, expected, html] of matrix) {
    const { doc, from, to } = pick(src)
    for (const reverse of [false, true]) {
      await reset(doc, from, to, reverse)
      const copied = await copy()
      check(`${name}${reverse ? '（反向）' : ''}`, () => {
        assert.equal(copied.text, expected)
        assert.ok(copied.unchanged, '复制不能修改文档或选区')
        for (const want of [html ?? []].flat()) {
          if (want.startsWith('!')) assert.ok(!copied.html.includes(want.slice(1)), copied.html)
          else assert.ok(copied.html.includes(want), copied.html)
        }
      })
    }
  }

  // 与 main 的图表导出修复组合：图表沿用代码围栏类，但不能被复制层当成空代码块删掉。
  const diagramDoc = '前文\n\n```mermaid\ngraph TD\n A-->B\n```\n\n末文'
  await reset(diagramDoc, 0, 0)
  for (let i = 0; i < 100; i++) {
    if (await ev(`!!document.querySelector('.cm-md-mermaid-ready svg')`)) break
    await delay(100)
  }
  const diagram = await ev(`(() => {
    const svg=document.querySelector('.cm-md-mermaid-ready svg');
    const html=window.__colamdExportDocumentHTML();
    return {ready:!!svg,preserved:!!svg&&html.includes(svg.outerHTML),html,text:v.state.doc.toString()}
  })()`)
  check('最新 main 的 Mermaid SVG 在整篇 HTML 导出中保留', () => {
    assert.ok(diagram.ready, '图表必须真实完成渲染')
    assert.ok(diagram.preserved, diagram.html)
    assert.equal(diagram.text, diagramDoc)
  })
  await ev('v.dispatch({selection:{anchor:0,head:v.state.doc.length}})')
  const diagramCopy = await copy()
  check('跨图表复制保留 SVG、围栏源码及选区', () => {
    assert.equal(diagramCopy.text, diagramDoc)
    assert.ok(diagramCopy.html.includes('<svg'), diagramCopy.html)
    assert.ok(diagramCopy.unchanged)
  })

  // 富文本颜色看重新插入 HTML 后的计算样式，不能只断言字符串里有 style。
  const inspectHTML = (html, labels) => ev(`(() => {
    const host=document.createElement('div');host.style.cssText='position:absolute;left:-100000px;color:rgb(1,2,3)';
    host.innerHTML=${JSON.stringify(html)};document.body.appendChild(host);
    const result={};
    for(const label of ${JSON.stringify(labels)}) {
      const walker=document.createTreeWalker(host,NodeFilter.SHOW_TEXT);let text;
      while((text=walker.nextNode())) if(text.textContent.includes(label)) {
        const css=getComputedStyle(text.parentElement);
        result[label]={color:css.color,background:css.backgroundColor,weight:css.fontWeight};break
      }
    }
    host.remove();return result
  })()`)
  for (const [name, src, expected, label, color, extra] of [
    ['完整红字', '<span style="color:red">⟦红字⟧</span>', '<span style="color:red">红字</span>', '红字', 'rgb(255, 0, 0)'],
    ['部分红字', '<span style="color:red">红⟦色文字⟧</span>', '<span style="color:red">色文字</span>', '色文字', 'rgb(255, 0, 0)'],
    ['红字内的加粗', '<span style="color:red">**⟦粗红字⟧**</span>', '<span style="color:red">**粗红字**</span>', '粗红字', 'rgb(255, 0, 0)', 'strong'],
    ['加粗内的红字', '**<span style="color:red">⟦粗红字⟧</span>**', '**<span style="color:red">粗红字</span>**', '粗红字', 'rgb(255, 0, 0)', 'strong'],
    ['红字内的高亮', '<span style="color:red">==⟦高亮红字⟧==</span>', '<span style="color:red">==高亮红字==</span>', '高亮红字', 'rgb(255, 0, 0)'],
    ['红字内的链接', '<span style="color:red">[⟦红色链接⟧](https://example.com)</span>', '<span style="color:red">[红色链接](https://example.com)</span>', '红色链接', 'rgb(255, 0, 0)'],
    ['链接内的红字', '[<span style="color:red">⟦红色链接⟧</span>](https://example.com)', '[<span style="color:red">红色链接</span>](https://example.com)', '红色链接', 'rgb(255, 0, 0)'],
    ['标题内红字', '### <span style="color:red">⟦红字⟧</span>', '<span style="color:red">红字</span>', '红字', 'rgb(255, 0, 0)'],
    ['从标题中间跨块的红字', '### 示例<span style="color:red">红⟦色文字</span>\n\n正文⟧', '### <span style="color:red">色文字</span>\n\n正文', '色文字', 'rgb(255, 0, 0)'],
    ['十六进制颜色', '<span style="color:#12ab34">⟦绿字⟧</span>', '<span style="color:#12ab34">绿字</span>', '绿字', 'rgb(18, 171, 52)'],
    ['文字色与背景色', '<span style="color:red;background-color:yellow">⟦红字⟧</span>', '<span style="color:red;background-color:yellow">红字</span>', '红字', 'rgb(255, 0, 0)', 'background'],
    ['沿用样式白名单', '<span style="color:red;position:fixed">⟦红字⟧</span>', '<span style="color:red;position:fixed">红字</span>', '红字', 'rgb(255, 0, 0)', 'filtered'],
    ['颜色不影响后文', '<span style="color:red">⟦红字</span>后文⟧', '<span style="color:red">红字</span>后文', '红字', 'rgb(255, 0, 0)', 'tail'],
  ]) {
    const { doc, from, to }=pick(src)
    for (const reverse of [false,true]) {
      await reset(doc,from,to,reverse)
      const copied=await copy()
      const labels=extra==='tail'?[label,'后文']:[label]
      const rendered=await inspectHTML(copied.html,labels)
      check(`${name} 富文本复制${reverse?'（反向）':''}`,()=>{
        assert.equal(copied.text,expected)
        assert.ok(copied.unchanged)
        assert.equal(rendered[label]?.color,color,copied.html)
        assert.ok(!copied.html.includes('cm-md-'),copied.html)
        if(name.includes('链接')) assert.ok(copied.html.includes('<a href="https://example.com"'),copied.html)
        if(name.includes('高亮')) assert.ok(copied.html.includes('<mark'),copied.html)
        if(extra==='strong') assert.ok(Number(rendered[label].weight)>=600,copied.html)
        if(extra==='background') assert.equal(rendered[label].background,'rgb(255, 255, 0)')
        if(extra==='filtered') assert.ok(!copied.html.includes('position'),copied.html)
        if(extra==='tail') assert.equal(rendered['后文']?.color,'rgb(1, 2, 3)')
      })
    }
    const exported=await ev('window.__colamdExportDocumentHTML()')
    const rendered=await inspectHTML(exported,[label])
    check(`${name} HTML 导出保留颜色`,()=>{
      assert.equal(rendered[label]?.color,color,exported)
      if(extra==='filtered') assert.ok(!exported.includes('position'),exported)
    })
  }

  // 真正经过系统剪贴板，在浏览器的富文本编辑区粘贴，再读文字颜色。
  {
    const {doc,from,to}=pick('<span style="color:#12ab34">⟦绿字⟧</span>')
    await reset(doc,from,to)
    await key('c',[mod])
    await ev(`(() => {const target=document.createElement('div');target.id='copy-color-target';target.contentEditable='true';document.body.appendChild(target);target.focus()})()`)
    await key('v',[mod])
    const pasted=await ev(`(() => {const target=document.getElementById('copy-color-target');const html=target.innerHTML;target.remove();return html})()`)
    const rendered=await inspectHTML(pasted,['绿字'])
    check('系统剪贴板粘到富文本编辑区保留文字颜色',()=>assert.equal(rendered['绿字']?.color,'rgb(18, 171, 52)',pasted))
  }

  // 粘回 ColaMD：系统剪贴板、粘贴、撤销、重做走一遍
  for (const [name, src, expected] of [
    ['高亮', '正文 ==⟦高亮⟧== 结尾', '==高亮=='],
    ['加粗标题开头', '## **⟦加粗**标题⟧\n\n', '**加粗**标题'],
    ['列表', '- ⟦苹果\n- 香蕉⟧\n\n', '- 苹果\n- 香蕉'],
    ['代码跨出', '```js\nconst ⟦a\n```\n\n正文⟧', '```js\na\n```\n\n正文'],
  ]) {
    const { doc, from, to } = pick(src)
    await reset(doc, from, to)
    await key('c', [mod])
    const nativeText = await clipboard.readText()
    check(`${name} 系统剪贴板`, () => assert.equal(nativeText, expected))
    await ev(`v.dispatch({selection:{anchor:v.state.doc.length}});v.focus()`)
    await key('v', [mod])
    const pasted = await ev('v.state.doc.toString()')
    check(`${name} 粘贴`, () => assert.equal(pasted, doc + expected))
    await key('z', [mod])
    const undone = await ev('v.state.doc.toString()')
    check(`${name} 撤销还原原文`, () => assert.equal(undone, doc))
    await key('z', [mod, 'shift'])
    const redone = await ev('v.state.doc.toString()')
    check(`${name} 重做还原粘贴`, () => assert.equal(redone, pasted))
  }

  // ⌘A：代码块里先选代码，再按一次全文；别处直接全文
  {
    const doc = '开头\n\n```js\nconst a = 1\nconst b = 2\n```\n\n> 引用一\n> 引用二\n\n结尾'
    const codeFrom = doc.indexOf('const a'), codeTo = doc.indexOf('2\n```') + 1
    const selection = () => ev('[v.state.selection.main.from, v.state.selection.main.to]')
    await reset(doc, codeFrom + 3, codeFrom + 3)
    await key('a', [mod])
    const first = await selection()
    check('⌘A 在代码块里只选代码', () => assert.deepEqual(first, [codeFrom, codeTo]))
    const copied = await copy()
    check('⌘A 选中的代码复制出来没有围栏', () => assert.equal(copied.text, 'const a = 1\nconst b = 2'))
    await key('a', [mod])
    const second = await selection()
    check('再按 ⌘A 选中全文', () => assert.deepEqual(second, [0, doc.length]))
    await reset(doc, doc.indexOf('```js') + 2, doc.indexOf('```js') + 2)
    await key('a', [mod])
    const onFence = await selection()
    check('⌘A 在围栏行上也只选代码', () => assert.deepEqual(onFence, [codeFrom, codeTo]))
    await reset(doc, doc.indexOf('引用一') + 1, doc.indexOf('引用一') + 1)
    await key('a', [mod])
    const inQuote = await selection()
    check('⌘A 在引用里选中全文', () => assert.deepEqual(inQuote, [0, doc.length]))
    await reset(doc, 1, 1)
    await key('a', [mod])
    const inText = await selection()
    check('⌘A 在正文里选中全文', () => assert.deepEqual(inText, [0, doc.length]))
    const empty = '```\n```\n\n正文'
    await reset(empty, 2, 2)
    await key('a', [mod])
    const onEmpty = await selection()
    check('⌘A 在空代码块里选中全文', () => assert.deepEqual(onEmpty, [0, empty.length]))
  }

  const themes = ['light', 'dark', 'elegant', 'sepia', 'notion', 'bear', 'writer', 'solarized-dark', 'nord', 'gruvbox', 'dracula', 'midnight']
  for (const theme of themes) {
    await ev(`document.body.className=${JSON.stringify('theme-' + theme)}`)
    const doc = '### 主题标题\n\n后续正文'
    await sample(`${theme} 主题跨块复制`, doc, 4, doc.length, doc, 3)
  }
  const endDoc = '### 首标题\n\n正文\n\n###### 末标题'
  await sample('选区结束在另一个标题中间不扩展末端', endDoc, 4, endDoc.indexOf('末标题') + 1,
    endDoc.slice(0, endDoc.indexOf('末标题') + 1), 3)

  // 选区跨出视口时，应用异步补写系统剪贴板的 HTML，不能只测同步事件。
  const longDoc = '前置正文\n\n'.repeat(120) + '###### 长文标题\n\n' + '长文正文\n\n'.repeat(180) + '长文结束标记'
  const longFrom = longDoc.indexOf('长文标题'), longExpected = longDoc.slice(longDoc.indexOf('######'))
  await reset(longDoc, longFrom, longDoc.length)
  await key('c', [mod])
  let longText = '', longHTML = ''
  for (let i = 0; i < 80; i++) {
    longText = await clipboard.readText()
    const items = await clipboard.read()
    longHTML = items[0]?.types.includes('text/html') ? await (await items[0].getType('text/html')).text() : ''
    if (longText === longExpected && longHTML.includes('长文结束标记')) break
    await delay(50)
  }
  check('长文档异步复制补齐第一个标题', () => assert.equal(longText, longExpected))
  check('长文档异步复制 HTML 包含首标题与末段', () => {
    assert.ok(longHTML.includes('<h6>长文标题</h6>'))
    assert.ok(longHTML.includes('长文结束标记'))
  })
  const longAfter = await ev('v.state.doc.toString()')
  check('长文档复制未改写原文', () => assert.equal(longAfter, longDoc))

  // 剪切不参与补前缀：删掉的字与剪贴板的字必须一致，不能多删隐藏标记。
  const cutDoc = '### 剪切标题\n\n剪切正文'
  await reset(cutDoc, 4, cutDoc.length)
  await key('x', [mod])
  const cutText = await clipboard.readText()
  check('跨块剪切仍精确匹配原始选区', () => assert.equal(cutText, cutDoc.slice(4)))
  const cutLeft = await ev('v.state.doc.toString()')
  check('剪切没有额外删除标题标记', () => assert.equal(cutLeft, '### '))
  await key('z', [mod])
  const cutUndo = await ev('v.state.doc.toString()')
  check('剪切撤销还原原文', () => assert.equal(cutUndo, cutDoc))

  // 跨文件粘贴：真实 IPC 打开第二个临时文件，同时检查源文件没有被写入。
  await reset(files.initial, 4, files.initial.length)
  await delay(1200)
  const sourceBefore = readFileSync(files.source), sourceMtime = statSync(files.source).mtimeMs
  await key('c', [mod])
  const crossText = await clipboard.readText()
  win.webContents.send('file-opened', { path: files.destination, content: files.target })
  for (let i = 0; i < 80; i++) {
    if (await ev('v.state.doc.toString()') === files.target) break
    await delay(50)
  }
  assert.equal(await ev('v.state.doc.toString()'), files.target)
  await ev('v.dispatch({selection:{anchor:v.state.doc.length}});v.focus()')
  await key('v', [mod])
  const crossPasted = await ev('v.state.doc.toString()')
  check('跨文件粘贴保留第一个标题', () => assert.equal(crossPasted, files.target + crossText))
  await key('z', [mod])
  const crossUndo = await ev('v.state.doc.toString()')
  check('跨文件粘贴可独立撤销', () => assert.equal(crossUndo, files.target))
  await delay(1200)
  check('跨文件操作未改写源文件内容与 mtime', () => {
    assert.deepEqual(readFileSync(files.source), sourceBefore)
    assert.equal(statSync(files.source).mtimeMs, sourceMtime)
  })

  // 源码模式直接复制所选字节，不根据渲染标题扩展。
  await ev(`document.getElementById('source-toggle-btn').click();const ta=document.getElementById('source-editor');ta.value='### 源码标题\\n\\n正文';ta.focus();ta.setSelectionRange(4,ta.value.length)`)
  await key('c', [mod])
  const sourceText = await clipboard.readText()
  check('源码模式复制不补前缀', () => assert.equal(sourceText, '源码标题\n\n正文'))

  if (checks.some(check => !check.ok)) throw Error('复制原文验收有失败项')
}

const timeout = setTimeout(() => { console.error('复制原文验收超时'); finish(1) }, 180000)
timeout.unref()
main().catch(error => { console.error(error); finish(1) })
