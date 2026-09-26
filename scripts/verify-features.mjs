#!/usr/bin/env node
// 功能验收：把 changelog 里承诺过的功能，在新编辑器核心下逐条量一遍。
//
// 为什么需要它：换核心（milkdown/ProseMirror → CodeMirror 6 文本优先）会静默丢掉
// 一批「渲染 + 交互」能力——类型检查过得去，构建也过得去，只有真机上才看得出
// 图片不显示、脚注没预览、复制出来是源码。这个脚本把那些能力写成断言。
//
// 用法: npm run verify:features（先 npm run build）
// 窗口放在屏幕外，不占用屏幕；一次启动跑完所有断言。
//
// 注意：页面侧表达式写在模板字符串里，反斜杠会被模板字符串吃掉一次，
// 所以那边一律用 includes() 而不是正则；非要匹配反引号时写 \x60。
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const WORK = join(homedir(), 'Library', 'Caches', `colamd-verify-features-${Date.now()}`)

/** 1×1 透明 PNG，用来验证本地图片能不能画出来。 */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

/**
 * 夹具：每一条对应 changelog 里一个承诺。断言按「文字片段」定位行，片段必须唯一。
 */
function fixture() {
  return [
    '---',
    'title: 功能验收',
    'tags: [a, b]',
    '---',
    '',
    '# 一级标题',
    '',
    '普通段落，含 **加粗**、*斜体*、~~删除线~~、`行内代码`、==高亮==、',
    '[链接文字](https://example.com/a) 和 [站内跳转](#一级标题)。',
    '',
    '![本地图片](pixel.png)',
    '',
    '## 二级标题',
    '',
    '- 无序项一',
    '- 无序项二',
    '  - 嵌套项',
    '- [ ] 待办未完成',
    '- [x] 待办已完成',
    '',
    '1. 有序项一',
    '2. 有序项二',
    '',
    '> 引用文字',
    '> 引用第二行',
    '',
    '---',
    '',
    '```js',
    '// 注释一行',
    'const answer = 42',
    'function greet(name) {',
    "  return 'hi ' + name",
    '}',
    '```',
    '',
    '| 列甲 | 列乙 |',
    '| --- | --- |',
    '| 甲一 | 乙一 |',
    '',
    '行内公式 $a^2+b^2=c^2$ 与价格 $349。',
    '',
    '$$',
    '\\int_0^1 x^2 dx',
    '$$',
    '',
    '```mermaid',
    'graph TD; A-->B;',
    '```',
    '',
    '脚注引用[^note]。',
    '',
    '[^note]: 脚注定义内容。',
    '',
    '<div class="raw-html">HTML 块</div>',
    '',
  ].join('\n')
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
  return client.send('Runtime.evaluate', {
    expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true
  }).then((result) => {
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 500))
    return result.result?.value
  })
}

/** 把界面上所有该量的东西一次量完，断言在 Node 侧做。 */
const MEASURE = `(() => {
  const q = (s) => [...document.querySelectorAll(s)]
  const content = document.querySelector('#editor .cm-content')
  const lines = q('#editor .cm-line')
  const lineOf = (frag) => lines.find((l) => l.textContent.includes(frag))
  const text = (el) => (el ? el.textContent : null)
  const has = (el, frag) => (el ? el.textContent.includes(frag) : null)
  const colorOf = (el) => (el ? getComputedStyle(el).color : null)

  return JSON.stringify({
    headings: {
      h1: q('.cm-md-atxheading1').length,
      h2: q('.cm-md-atxheading2').length,
      raw: has(lineOf('一级标题'), '#')
    },
    inline: {
      strong: q('.cm-md-strong').length,
      em: q('.cm-md-em').length,
      strike: q('.cm-md-strike').length,
      code: q('.cm-md-inlinecode').length,
      highlight: q('.cm-md-highlight').length,
      raw: has(lineOf('普通段落'), '**') || has(lineOf('普通段落'), '==') || has(lineOf('普通段落'), '~~')
    },
    link: {
      anchors: q('#editor [data-href]').length,
      brackets: has(lineOf('链接文字'), ']('),
      url: text(lineOf('链接文字'))
    },
    image: {
      imgs: q('#editor img').filter((i) => !i.classList.contains('cm-widgetBuffer')).length,
      src: (q('#editor img').filter((i) => !i.classList.contains('cm-widgetBuffer'))[0] || { getAttribute: () => null }).getAttribute('src'),
      naturalWidth: (q('#editor img').filter((i) => !i.classList.contains('cm-widgetBuffer'))[0] || {}).naturalWidth || 0,
      raw: has(lineOf('pixel.png'), '![')
    },
    list: {
      bullets: q('.cm-md-li-bullet').length,
      // 嵌套那一行的层级类：必须只有它自己那一层。
      // 一个 ListItem 的区间包含它的子列表，按区间铺类的话这里会同时出现 li-0 和 li-1。
      nestedClass: (() => {
        const line = lines.find((l) => l.textContent.includes('嵌套项'))
        return line ? line.className : null
      })(),
      nested: q('.cm-md-li-1').length,
      tasks: q('.cm-md-task').length,
      checked: q('.cm-md-task-checked').length,
      ordered: text(lineOf('有序项一'))
    },
    table: {
      tables: q('.cm-md-table-widget').length,
      realTables: q('table.cm-md-table-widget').length,
      cells: q('.cm-md-table-widget td').length,
      headers: q('.cm-md-table-widget th').length
    },
    quote: { count: q('.cm-md-blockquote').length, raw: (text(lineOf('引用文字')) || '').startsWith('>') },
    hr: { count: q('.cm-md-hr').length },
    math: { katex: q('.katex').length, block: q('.cm-md-math-block').length, error: q('.cm-md-math-error').length },
    mermaid: { ready: q('.cm-md-mermaid-ready').length, svg: q('.cm-md-mermaid svg').length, failed: q('.cm-md-mermaid-failed').length },
    code: (() => {
      const block = q('.cm-md-codeblock')
      const tokens = block
        .flatMap((l) => [...l.querySelectorAll('span')])
        .filter((s) => s.textContent.trim() !== '' && s.className !== '')
        .map((s) => ({ text: s.textContent, color: getComputedStyle(s).color }))
      const colors = []
      for (const t of tokens) if (colors.indexOf(t.color) === -1) colors.push(t.color)
      return {
        lines: block.length,
        fenceVisible: content ? content.textContent.indexOf('\\x60\\x60\\x60') !== -1 : null,
        tokens: tokens.length,
        colors: colors.length,
        sample: tokens.slice(0, 6).map((t) => t.text + ' ' + t.color).join(' | '),
        bodyColor: colorOf(content),
        copyButton: q('.code-copy-btn').length,
        langLabel: q('.cm-md-codeinfo').length
      }
    })(),
    frontmatter: {
      count: q('.cm-md-frontmatter').length,
      color: colorOf(q('.cm-md-frontmatter')[0]),
      bodyColor: colorOf(document.querySelector('#editor .cm-content'))
    },
    footnote: {
      refs: q('.cm-md-footnote-ref').length,
      previewCard: q('.footnote-preview').length,
      raw: has(lineOf('脚注引用'), '[^')
    },
    html: { rendered: q('#editor .raw-html').length, raw: has(lineOf('HTML 块'), '<div') },
    exportHtml: (() => {
      const out = typeof window.__colamdExportDocumentHTML === 'function'
        ? window.__colamdExportDocumentHTML()
        : ''
      return {
        size: out.length,
        strong: /<strong>/i.test(out),
        em: /<em>/i.test(out),
        img: /<img[^>]+src/i.test(out),
        anchor: /<a[^>]+href/i.test(out),
        list: /<ul>|<ol>/i.test(out),
        code: /<pre><code>/i.test(out),
        table: /<table/i.test(out),
        quote: /<blockquote>/i.test(out),
        heading: /<h1>/i.test(out),
        cmLine: /class="cm-line/.test(out),
        cmClass: /cm-md-/.test(out),
        cmClassNames: (out.match(/cm-md-[a-z0-9-]+/g) || []).filter((v, i, a) => a.indexOf(v) === i).join(','),
        frontmatter: /title: 功能验收/.test(out)
      }
    })()
  })
})()`

/**
 * 复制一段带加粗的选区，看剪贴板里两个口味各是什么。
 *
 * 选区走键盘（点一下定位光标，Home、Shift+End），不自己设 DOM 选区：
 * CodeMirror 会重渲染行元素，程序设的 DOM 选区可能被丢掉或映射错位置，实测时好时坏。
 */
const COPY_PROBE = `(() => {
  const selection = window.getSelection()
  const data = new DataTransfer()
  const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })
  document.querySelector('#editor .cm-content').dispatchEvent(event)
  return JSON.stringify({
    html: data.getData('text/html'),
    text: data.getData('text/plain'),
    handled: event.defaultPrevented,
    diag: {
      collapsed: selection.isCollapsed,
      ranges: selection.rangeCount,
      children: selection.rangeCount > 0 ? selection.getRangeAt(0).cloneContents().childNodes.length : -1,
      contentFocus: document.querySelector('#editor .cm-content') === document.activeElement
    }
  })
})()`

/**
 * 全选：走 CodeMirror 自己的 keymap。它的 keymap 是 contentDOM 上的 DOM 监听器，
 * 所以合成的 keydown 能进得去（CDP 的真键盘事件反而进不去，实测选不中任何东西）。
 */
const SELECT_ALL = `(() => {
  const content = document.querySelector('#editor .cm-content')
  content.focus()
  content.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'a', code: 'KeyA', metaKey: true, bubbles: true, cancelable: true,
  }))
  return 'ok'
})()`

/**
 * 语法速查那份文档（帮助菜单里那份）的体检。
 *
 * 它是发给用户的**功能演示文档**，也是我们自己看渲染结果最省事的一份：图片、链接、
 * 脚注、公式、HTML、图表、代码着色全在里面。它要是哪一节没渲染，用户一眼就能看到。
 */
const CHEATSHEET_MEASURE = `(() => {
  const q = (s) => [...document.querySelectorAll(s)]
  const imgs = q('#editor img').filter((i) => !i.classList.contains('cm-widgetBuffer'))
  const tokens = q('.cm-md-codeblock span').filter((s) => s.textContent.trim() !== '' && s.className !== '')
  const colors = []
  for (const t of tokens) {
    const c = getComputedStyle(t).color
    if (colors.indexOf(c) === -1) colors.push(c)
  }
  return JSON.stringify({
    lines: q('#editor .cm-line').length,
    images: imgs.length,
    imageLoaded: imgs.length > 0 && imgs[0].naturalWidth > 0,
    imageSrc: imgs.length > 0 ? imgs[0].getAttribute('src') : null,
    katex: q('.cm-md-math .katex').length,
    footnotes: q('.cm-md-footnote-ref').length,
    htmlBlocks: q('.cm-md-html').length,
    mermaid: q('.cm-md-mermaid-ready svg').length,
    codeColors: colors.length,
    headings: q('.cm-md-atxheading1, .cm-md-atxheading2').length,
    codeLines: q('.cm-md-codeblock').length
  })
})()`

/** 一次光标移动要多久：装饰层在选区变化时会重算，长文档上会露馅。 */
const PERF_PROBE = `(async () => {
  const send = (key) => new Promise((resolve) => {
    const event = new KeyboardEvent('keydown', { key: key, code: key, bubbles: true })
    document.querySelector('#editor .cm-content').dispatchEvent(event)
    requestAnimationFrame(() => resolve())
  })
  const started = performance.now()
  for (let i = 0; i < 30; i++) await send('ArrowDown')
  return Math.round(performance.now() - started)
})()`

/** 真键盘连按 30 次下键，量墙钟时间（合成事件 CM6 会忽略，量不到东西）。 */
async function measureKeys(renderer) {
  const started = Date.now()
  for (let i = 0; i < 30; i++) {
    await renderer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
    await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
  }
  return Date.now() - started
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
}

/** 点一下某一行（把光标放进去），返回它的坐标。 */
async function clickLine(renderer, fragment) {
  const box = JSON.parse(await evaluate(renderer, `(() => {
    const line = [...document.querySelectorAll('#editor .cm-line')].find((l) => l.textContent.includes(${JSON.stringify(fragment)}))
    if (!line) return JSON.stringify({ x: 0, y: 0 })
    const r = line.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) })
  })()`))
  for (const type of ['mousePressed', 'mouseReleased']) {
    if (!box.x) break
    await renderer.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  await sleep(200)
  return box
}

async function lineText(renderer, fragment) {
  return await evaluate(renderer, `(() => {
    const line = [...document.querySelectorAll('#editor .cm-line')].find((l) => l.textContent.includes(${JSON.stringify(fragment)}))
    return line ? line.textContent : null
  })()`)
}

async function lineClass(renderer, fragment) {
  return await evaluate(renderer, `(() => {
    const line = [...document.querySelectorAll('#editor .cm-line')].find((l) => l.textContent.includes(${JSON.stringify(fragment)}))
    return line ? line.className : null
  })()`)
}

/** 真键盘按一个键（合成事件 CodeMirror 不认）。 */
async function pressKey(renderer, key, code, keyCode, modifiers = 0) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await renderer.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, modifiers })
  }
  await sleep(200)
}

/** 语法速查：单独开一次窗口量一遍（它和夹具不是同一份文档）。 */
async function checkCheatsheet() {
  const source = join(APP, 'resources', 'templates', 'cheatsheet.md')
  const port = 9990 + Math.floor(Math.random() * 9)
  const child = spawn('npx', ['electron', '.', source, `--user-data-dir=${join(WORK, 'udd-cheatsheet')}`,
    '--window-position=-4000,-4000', `--remote-debugging-port=${port}`
  ], { cwd: APP, stdio: 'ignore', detached: true })

  try {
    const page = await waitTarget(port, (t) => t.type === 'page' && /index\.html/.test(t.url))
    const renderer = await connect(page.webSocketDebuggerUrl)
    await renderer.send('Emulation.setDeviceMetricsOverride', {
      width: 1200, height: 3600, deviceScaleFactor: 1, mobile: false
    })
    for (let i = 0; i < 80; i++) {
      const lines = await evaluate(renderer, `document.querySelectorAll('#editor .cm-line').length`)
      if (Number(lines) > 100) break
      await sleep(250)
    }
    // 图片和 Mermaid 是异步渲染的，机器忙的时候会晚一点。等它稳定再断言，
    // 不要睡一个固定时长（2026-09-26：连续跑测试时这里会假红）。
    let m = JSON.parse(await evaluate(renderer, CHEATSHEET_MEASURE))
    for (let i = 0; i < 60; i++) {
      if (m.imageLoaded === true && m.katex >= 2 && m.mermaid >= 1) break
      await sleep(250)
      m = JSON.parse(await evaluate(renderer, CHEATSHEET_MEASURE))
    }

    check('速查文档：整篇渲染', m.lines >= 100, `行数=${m.lines}`)
    check('速查文档：图片加载', m.images >= 1 && m.imageLoaded === true,
      `图片=${m.images} 加载成功=${m.imageLoaded} src=${m.imageSrc}`)
    check('速查文档：公式渲染', m.katex >= 2, `katex=${m.katex}`)
    check('速查文档：脚注渲染', m.footnotes >= 1, `脚注=${m.footnotes}`)
    check('速查文档：HTML 块渲染', m.htmlBlocks >= 1, `HTML 块=${m.htmlBlocks}`)
    check('速查文档：图表渲染', m.mermaid >= 1, `mermaid svg=${m.mermaid}`)
    check('速查文档：代码着色', m.codeColors >= 4, `代码颜色种类=${m.codeColors}`)
    check('速查文档：标题与代码块渲染', m.headings >= 5 && m.codeLines >= 6,
      `标题=${m.headings} 代码块行=${m.codeLines}`)
  } finally {
    try { process.kill(-child.pid) } catch { /* 已经退了 */ }
  }
}

function main() {
  return (async () => {
    mkdirSync(WORK, { recursive: true })
    const source = join(WORK, 'features.md')
    writeFileSync(source, fixture(), 'utf8')
    writeFileSync(join(WORK, 'pixel.png'), PIXEL_PNG)

    const port = 9960 + Math.floor(Math.random() * 30)
    const child = spawn('npx', ['electron', '.', source, `--user-data-dir=${join(WORK, 'udd')}`,
      '--window-position=-4000,-4000', `--remote-debugging-port=${port}`
    ], { cwd: APP, stdio: 'ignore', detached: true })

    try {
      const page = await waitTarget(port, (t) => t.type === 'page' && /index\.html/.test(t.url))
      const renderer = await connect(page.webSocketDebuggerUrl)
      // CodeMirror 只为**视口内**的行建 DOM。夹具比一屏长，视口不高的话下半段根本不在
      // DOM 里，会被误判成「没渲染」。先把视口撑到能装下整篇，再量。
      await renderer.send('Emulation.setDeviceMetricsOverride', {
        width: 1200, height: 2600, deviceScaleFactor: 1, mobile: false
      })
      for (let i = 0; i < 80; i++) {
        const lines = await evaluate(renderer, `document.querySelectorAll('#editor .cm-line').length`)
        if (Number(lines) > 5) break
        await sleep(250)
      }
      // mermaid 是异步画的，多等一会儿
      await sleep(2500)

      const m = JSON.parse(await evaluate(renderer, MEASURE))

      check('标题渲染', m.headings.h1 >= 1 && m.headings.h2 >= 1, `h1=${m.headings.h1} h2=${m.headings.h2}`)
      check('标题标记隐藏', m.headings.raw === false, `行里还看得到 #: ${m.headings.raw}`)
      check('行内格式渲染', m.inline.strong >= 1 && m.inline.em >= 1 && m.inline.strike >= 1 && m.inline.code >= 1,
        `strong=${m.inline.strong} em=${m.inline.em} strike=${m.inline.strike} code=${m.inline.code}`)
      check('行内格式标记隐藏', m.inline.raw === false, `还看得到原始标记: ${m.inline.raw}`)
      check('==高亮== 渲染', m.inline.highlight >= 1, `highlight=${m.inline.highlight}`)
      check('链接可点（带地址）', m.link.anchors >= 1, `带 data-href 的元素=${m.link.anchors}`)
      check('链接不露源码', m.link.brackets === false, `行内容: ${m.link.url}`)
      check('本地图片渲染', m.image.imgs >= 1 && m.image.naturalWidth > 0,
        `img=${m.image.imgs} naturalWidth=${m.image.naturalWidth} src=${m.image.src}`)
      check('列表圆点', m.list.bullets >= 3, `bullets=${m.list.bullets}`)
      check('嵌套列表缩进', m.list.nested >= 1, `嵌套行=${m.list.nested}`)
      check('嵌套行只带自己那一层的类',
        (m.list.nestedClass ?? '').includes('cm-md-li-1') && !(m.list.nestedClass ?? '').includes('cm-md-li-0'),
        `嵌套行类=${m.list.nestedClass}`)
      check('待办复选框', m.list.tasks >= 2 && m.list.checked >= 1, `tasks=${m.list.tasks} checked=${m.list.checked}`)
      check('表格渲染', m.table.realTables >= 1 && m.table.cells >= 2,
        `表格=${m.table.tables} 真 table=${m.table.realTables} cells=${m.table.cells}`)
      check('引用渲染', m.quote.count >= 1 && m.quote.raw === false, `count=${m.quote.count} 露 >: ${m.quote.raw}`)
      check('分隔线渲染', m.hr.count >= 1, `hr=${m.hr.count}`)
      check('公式渲染', m.math.katex >= 2, `katex=${m.math.katex} block=${m.math.block} error=${m.math.error}`)
      check('Mermaid 渲染', m.mermaid.ready >= 1 && m.mermaid.svg >= 1,
        `ready=${m.mermaid.ready} svg=${m.mermaid.svg} failed=${m.mermaid.failed}`)
      check('代码块底色', m.code.lines >= 3, `codeblock 行=${m.code.lines}`)
      check('代码围栏不露源码', m.code.fenceVisible === false, `正文里还看得到围栏: ${m.code.fenceVisible}`)
      check('代码语法高亮', m.code.tokens >= 8 && m.code.colors >= 4,
        `token=${m.code.tokens} 颜色种类=${m.code.colors} 样例 ${m.code.sample}`)
      check('语言名压淡', m.code.langLabel >= 1, `语言名标注=${m.code.langLabel}`)
      check('代码块复制按钮', m.code.copyButton >= 1, `按钮数=${m.code.copyButton}`)
      check('属性区压淡', m.frontmatter.count >= 1 && m.frontmatter.color !== m.frontmatter.bodyColor,
        `count=${m.frontmatter.count} 属性区色=${m.frontmatter.color} 正文色=${m.frontmatter.bodyColor}`)
      check('脚注渲染', m.footnote.refs >= 1, `refs=${m.footnote.refs} 露源码=${m.footnote.raw}`)
      check('脚注悬停预览', m.footnote.previewCard >= 1, `预览卡片=${m.footnote.previewCard}`)
      check('HTML 块渲染', m.html.rendered >= 1, `rendered=${m.html.rendered} 露源码=${m.html.raw}`)
      check('导出的 HTML 是语义标签',
        m.exportHtml.strong && m.exportHtml.em && m.exportHtml.anchor && m.exportHtml.list &&
        m.exportHtml.code && m.exportHtml.table && m.exportHtml.quote && m.exportHtml.heading,
        `strong=${m.exportHtml.strong} em=${m.exportHtml.em} a=${m.exportHtml.anchor} ul=${m.exportHtml.list} pre=${m.exportHtml.code} table=${m.exportHtml.table} quote=${m.exportHtml.quote} h1=${m.exportHtml.heading}`)
      check('导出的 HTML 不带编辑器结构',
        m.exportHtml.cmClass === false && m.exportHtml.cmLine === false && m.exportHtml.frontmatter === false,
        `cm-md 类名残留=${m.exportHtml.cmClass}[${m.exportHtml.cmClassNames}] cm-line 残留=${m.exportHtml.cmLine} 属性区残留=${m.exportHtml.frontmatter}`)
      check('导出的 HTML 带图片', m.exportHtml.img === true, `img=${m.exportHtml.img} 长度=${m.exportHtml.size}`)

      // 点一下把光标放到那一行，再用键盘选中整行
      await clickLine(renderer, '普通段落')
      await pressKey(renderer, 'Home', 'Home', 36)
      await pressKey(renderer, 'End', 'End', 35, 8)
      const copy = JSON.parse(await evaluate(renderer, COPY_PROBE))
      const paragraphs = (copy.html.match(/<p>/g) ?? []).length
      check('复制带富文本口味', /<strong/.test(copy.html) && copy.handled === true,
        `text/html 长度=${copy.html.length} 有处理器=${copy.handled} 诊断=${JSON.stringify(copy.diag)}`)
      check('复制的一行不被拆成多段', paragraphs === 1, `段落数=${paragraphs} html=${copy.html.slice(0, 160)}`)
      check('复制不带编辑器结构', copy.html !== '' && !copy.html.includes('cm-md-') && !copy.html.includes('cm-line'),
        `text/html: ${copy.html.slice(0, 120)}`)
      // 纯文本口味给的是**原文**（markdown 本身），不是洗过的文字：
      // 粘到 Typora 或另一个编辑器里，拿到的必须是能继续编辑的 markdown。
      check('复制的纯文本是原文',
        copy.text.includes('**加粗**') && copy.text.includes('==高亮=='),
        `text/plain: ${JSON.stringify(copy.text)}`)

      // 全选复制：CodeMirror 只为视口内的行建 DOM，选区伸到没渲染的地方时
      // 浏览器选区被夹在已渲染的那一段里，所以这里必须拿到整篇。
      await evaluate(renderer, SELECT_ALL)
      await sleep(300)
      const whole = JSON.parse(await evaluate(renderer, COPY_PROBE))
      check('全选复制拿到整篇', whole.text === fixture(),
        `复制到 ${whole.text.length} 字节，原文 ${fixture().length} 字节，结尾 ${JSON.stringify(whole.text.slice(-24))}`)
      const listTags = (html, tag) => [
        (html.match(new RegExp(`<${tag}>`, 'g')) ?? []).length,
        (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length,
      ]
      const unbalanced = ['ul', 'ol', 'li'].filter((tag) => {
        const [open, close] = listTags(whole.html, tag)
        return open !== close
      })
      check('复制的 HTML 列表结构合法',
        whole.html !== '' && unbalanced.length === 0 && !/<(ul|ol)>(?!<li>)/.test(whole.html),
        `不配对的标签=${unbalanced.join(',') || '无'} html=${whole.html.slice(0, 200)}`)

      const perf = await measureKeys(renderer)
      check('30 次光标移动 < 1200ms', perf < 1200, `${perf}ms`)

      // 真鼠标点一下待办复选框：源码里那个 `[ ]` 要变成 `[x]`。
      // 渲染之后源码看不见（被复选框盖住了），所以看「已勾选的数量」是不是多了一个。
      const checkedBefore = await evaluate(renderer, `document.querySelectorAll('.cm-md-task-checked').length`)
      const box = JSON.parse(await evaluate(renderer, `(() => {
        const el = document.querySelector('.cm-md-task:not(.cm-md-task-checked)')
        if (!el) return JSON.stringify({ x: 0, y: 0 })
        const r = el.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
      })()`))
      for (const type of ['mousePressed', 'mouseReleased']) {
        if (!box.x) break
        await renderer.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
      }
      await sleep(400)
      const checkedAfter = await evaluate(renderer, `document.querySelectorAll('.cm-md-task-checked').length`)
      check('点击待办能勾选', Number(checkedAfter) === Number(checkedBefore) + 1,
        `点击前已勾=${checkedBefore} 点击后=${checkedAfter} 坐标=${box.x},${box.y}`)

      await checkCheatsheet()

      // 列表缩进：Tab 把这一行缩进一级，Shift+Tab 退回来。
      // 判据分两层：光标在行上时看**源码文本**（多/少两个空格），移开光标后看**渲染层级**
      // （`cm-md-li-1` 有没有出现），后者证明这不只是空格变多了。
      await clickLine(renderer, '无序项二')
      // 光标在行上时看到的是**源码**（`- 无序项二`）；移开光标后这一行会被画成圆点，
      // 所以基准必须在点进去之后再取。
      const beforeIndent = await lineText(renderer, '无序项二')
      await pressKey(renderer, 'Tab', 'Tab', 9)
      const afterIndent = await lineText(renderer, '无序项二')
      await clickLine(renderer, '无序项一')
      const nestedClass = await lineClass(renderer, '无序项二')
      check('Tab 缩进列表项',
        afterIndent === '  ' + beforeIndent &&
        (nestedClass ?? '').includes('cm-md-li-1') && !(nestedClass ?? '').includes('cm-md-li-0'),
        `前=${JSON.stringify(beforeIndent)} 后=${JSON.stringify(afterIndent)} 移开光标后的类=${nestedClass}`)

      await clickLine(renderer, '无序项二')
      await pressKey(renderer, 'Tab', 'Tab', 9, 8)
      const backIndent = await lineText(renderer, '无序项二')
      await clickLine(renderer, '无序项一')
      const backClass = await lineClass(renderer, '无序项二')
      check('Shift+Tab 退回一级',
        backIndent === beforeIndent && !(backClass ?? '').includes('cm-md-li-1'),
        `退回后=${JSON.stringify(backIndent)} 类=${backClass}`)

      const failed = checks.filter((c) => !c.ok)
      for (const c of checks) {
        console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : `  ← ${c.detail}`}`)
      }
      console.log(failed.length
        ? `\n✗ ${failed.length}/${checks.length} 条没通过`
        : `\n✓ ${checks.length} 条全通过`)
      if (failed.length) process.exitCode = 1
    } finally {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已经退出 */ }
      await sleep(300)
      rmSync(WORK, { recursive: true, force: true })
    }
  })()
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exitCode = 1
})
