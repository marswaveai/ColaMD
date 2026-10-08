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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

const APP = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
assertBuildFresh()
const { dir: WORK, udd } = verifyWorkdir('features')

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
    'NEEL 前半段的锚点。',
    '',
    '**00:00:17 开场**',
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
    '3. 有序项二',
    '4. 有序项三',
    '',
    '> 引用文字',
    '> 引用第二行',
    '',
    '5. 起点为五',
    '6. 起点为六',
    '',
    '---',
    '',
    '```js',
    '// 注释一行',
    '# 这一行在代码块里，不该进大纲',
    'const answer = 42',
    'function greet(name) {',
    "  return 'hi ' + name",
    '}',
    '```',
    '',
    '| 列甲 | 列乙 |',
    '| --- | --- |',
    '| 甲一 | 乙一<br/>乙二 |',
    '| ![格子里的图](pixel.png) | 乙三 |',
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
    // #125：行内成对标签（<span style="color">…</span>）的 style 生效。开、合两个标签
    // 藏起来，中间的文字套一个 mark 装饰。这条断言钉住「红色的字」真的是红的。
    '行内上色：<span style="color: #ff0000">红色的字</span>。',
    '',
    // 查找跳转的靶子：这一条在文档最末尾，一屏高的视口里绝对看不见。
    'NEEL 后半段的锚点。',
    ''
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
    // 窗口被杀掉时 socket 会自己关：这时候必须有动静。以前挂着的请求永远不 settle，
    // 事件循环一空，脚本就静默 exit 0（2026-10-06 为了这个查了半小时）。
    ws.addEventListener('close', () => {
      for (const [, pending_] of pending) pending_.rej(new Error('调试目标已关闭（窗口被杀了？）'))
      pending.clear()
    })
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
    // 时间戳：一行粗体的 00:00:17 开场，必须整行同一个颜色。曾经中间那段被当成
    // emoji 短代码（character 是 string 的子标签），被代码块的字符串色染绿。
    timestamp: {
      colors: [...new Set([...lineOf('00:00:17').querySelectorAll('span')]
        .filter((el) => el.children.length === 0 && el.textContent.trim())
        .map((el) => getComputedStyle(el).color))],
      spans: [...lineOf('00:00:17').querySelectorAll('span')].filter((el) => el.textContent.trim()).map((el) => el.textContent)
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
      headers: q('.cm-md-table-widget th').length,
      // 格子里的 <br/> 要画成换行，格子里的图片要画出来
      brs: q('.cm-md-table-widget td br').length,
      imgs: q('.cm-md-table-widget td img').length
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
      // 阅读时不应占位置：行元素还在，但不该有高度
      visible: q('.cm-md-frontmatter').filter((el) => el.getBoundingClientRect().height > 0).length,
      color: colorOf(q('.cm-md-frontmatter')[0]),
      bodyColor: colorOf(document.querySelector('#editor .cm-content'))
    },
    footnote: {
      refs: q('.cm-md-footnote-ref').length,
      previewCard: q('.footnote-preview').length,
      raw: has(lineOf('脚注引用'), '[^')
    },
    html: { rendered: q('#editor .raw-html').length, raw: has(lineOf('HTML 块'), '<div') },
    inlineColor: (() => {
      const el = [...document.querySelectorAll('#editor .cm-content *')]
        .find((n) => n.textContent.trim() === '红色的字')
      return el ? colorOf(el) : null
    })(),
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
/**
 * 查找跳转的现场量法。视口被压成一屏高，所以「当前匹配项在视野里」这件事
 * 必须靠 getBoundingClientRect 判，不能像以前那样数 DOM 里的高亮元素个数：
 * 远处的匹配项本来就不在 DOM 里，数不出来。
 */
const SEARCH_JUMP = `JSON.stringify((() => {
  const sc = document.querySelector('#editor .cm-scroller')
  const cur = document.querySelector('#editor .search-match-current')
  const rect = cur ? cur.getBoundingClientRect() : null
  return {
    count: document.querySelector('.search-count') ? document.querySelector('.search-count').textContent : null,
    scrollTop: sc ? Math.round(sc.scrollTop) : null,
    currentInDom: !!cur,
    currentVisible: !!(rect && rect.top >= 0 && rect.bottom <= window.innerHeight),
    rect: rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom) } : null
  }
})())`

/**
 * 选中文字看得清吗。
 *
 * 只读变量值不够：CodeMirror 的 baseTheme 给选区钉的规则优先级更高，我们写的
 * `var(--selection-bg)` 可能压根没生效，而它默认是一条不透明的浅紫 #d7d4f0。
 * 所以这里量的是实际观感：把半透明的色带合成到底色上，再和文字色比对比度。
 * 量完把主题类原样换回去，不影响后面的断言。
 */
const SELECTION_READABILITY = `JSON.stringify((() => {
  const saved = document.body.className
  ;[...document.body.classList].filter((c) => c.startsWith('theme-')).forEach((c) => document.body.classList.remove(c))
  document.body.classList.add('theme-dark')

  const parse = (value) => {
    const m = /rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:[,/]\\s*([\\d.]+))?\\s*\\)/.exec(value || '')
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null
  }
  const hex = (value) => {
    const m = /^#([0-9a-f]{6})$/i.exec((value || '').trim())
    if (!m) return parse(value)
    const n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  const lum = (c) => {
    const f = (u) => { u /= 255; return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }

  const band = document.querySelector('#editor .cm-selectionLayer .cm-selectionBackground')
  const line = [...document.querySelectorAll('#editor .cm-line')].find((l) => l.textContent.includes('待办未完成'))
  const page = hex(getComputedStyle(document.body).getPropertyValue('--bg-color'))
  const bandColor = band ? parse(getComputedStyle(band).backgroundColor) : null
  const textColor = parse(line ? getComputedStyle(line).color : '')
  let effective = null, contrast = null
  if (bandColor && page && textColor) {
    effective = {
      r: Math.round(bandColor.r * bandColor.a + page.r * (1 - bandColor.a)),
      g: Math.round(bandColor.g * bandColor.a + page.g * (1 - bandColor.a)),
      b: Math.round(bandColor.b * bandColor.a + page.b * (1 - bandColor.a)),
      a: 1
    }
    contrast = Math.round(ratio(textColor, effective) * 100) / 100
  }
  const result = {
    themeClass: document.body.className,
    band: band ? getComputedStyle(band).backgroundColor : null,
    variable: getComputedStyle(document.body).getPropertyValue('--selection-bg').trim(),
    page: page ? 'rgb(' + page.r + ', ' + page.g + ', ' + page.b + ')' : null,
    effective: effective ? 'rgb(' + effective.r + ', ' + effective.g + ', ' + effective.b + ')' : null,
    text: line ? getComputedStyle(line).color : null,
    contrast
  }
  document.body.className = saved
  return result
})())`

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
  const child = spawn('npx', ['electron', 'scripts/offscreen-window.cjs', source, `--user-data-dir=${join(WORK, 'udd-cheatsheet')}`,
    `--remote-debugging-port=${port}`
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
      if (m.imageLoaded === true && m.katex >= 2 && m.mermaid >= 1 && m.codeColors >= 4) break
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

    // 大选区的复制：CodeMirror 只为视口建 DOM，所以全选时拿不到完整的富文本口味，
    // 得在 copy 事件之后把整篇渲染出来补上。这条断言看的是**系统剪贴板**：
    // 补写发生在事件之后，事件里的 clipboardData 里没有它（2026-09-26 报的）。
    await renderer.send('Browser.grantPermissions', {
      origin: 'file://', permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
    }).catch(() => { /* Electron 里读剪贴板本来就放行 */ })
    await renderer.send('Emulation.clearDeviceMetricsOverride')
    await sleep(600)
    // 读剪贴板、以及让 CodeMirror 自己接住 ⌘A（而不是浏览器的全选），都要求这个窗口
    // 真的拿到焦点。窗口在屏幕外，点一次不一定拿得到，所以点到为止地重试。
    await renderer.send('Page.bringToFront')
    await sleep(300)
    const editorBox = JSON.parse(await evaluate(renderer, `(() => {
      const r = document.querySelector('#editor .cm-content').getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + 20) })
    })()`))
    let focused = false
    for (let i = 0; i < 8; i++) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await renderer.send('Input.dispatchMouseEvent', { type, x: editorBox.x, y: editorBox.y, button: 'left', clickCount: 1 })
      }
      await sleep(400)
      // 只看 document.hasFocus() 不够：窗口拿到了焦点，编辑器本身不一定拿到了。
      // 编辑器没拿到的话，浏览器会抢走 ⌘A 只选中已渲染的一段，读剪贴板也会被拒。
      focused = (await evaluate(renderer, `(() => {
        const el = document.activeElement
        return !!(el && el.closest && el.closest('#editor .cm-content'))
      })()`)) === true
      if (focused) break
    }
    const gaps = Number(await evaluate(renderer, `document.querySelectorAll('#editor .cm-gap').length`))
    await evaluate(renderer, `document.querySelector('#editor .cm-content').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', metaKey: true, bubbles: true, cancelable: true }))`)
    const docBytes = readFileSync(source, 'utf8').length
    let eventData = { text: 0, html: 0 }
    let copied = {}
    let clip = ''
    // 合成的 ⌘A 有时会被浏览器抢走，只选中已渲染的那一段，选区就伸不到没渲染的地方。
    // 判据是复制出来的纯文本是不是整篇；不是就重新点回去、再来一遍。
    for (let attempt = 0; attempt < 4; attempt++) {
      await evaluate(renderer, `document.querySelector('#editor .cm-content').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65, which: 65, metaKey: true, bubbles: true, cancelable: true, composed: true }))`)
      await sleep(600)
      eventData = JSON.parse(await evaluate(renderer, `(() => {
        const data = new DataTransfer()
        const e = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })
        document.querySelector('#editor .cm-content').dispatchEvent(e)
        return JSON.stringify({ text: data.getData('text/plain').length, html: data.getData('text/html').length })
      })()`))
      await sleep(1800)
      clip = ''
      for (let i = 0; i < 4; i++) {
        clip = await evaluate(renderer, `(async () => {
          try {
            const items = await navigator.clipboard.read()
            const types = items[0].types
            const html = types.includes('text/html') ? await (await items[0].getType('text/html')).text() : ''
            return JSON.stringify({ types, htmlLen: html.length, head: html.slice(0, 24) })
          } catch (error) { return JSON.stringify({ error: String(error.message) }) }
        })()`)
        if (!clip.includes('error')) break
        // 读系统剪贴板要求文档有焦点，焦点可能在等待里掉了。重新点一下再读，
        // 剪贴板里的内容已经写好，重读不会把它弄掉。
        await renderer.send('Page.bringToFront')
        await sleep(300)
        for (const type of ['mousePressed', 'mouseReleased']) {
          await renderer.send('Input.dispatchMouseEvent', { type, x: editorBox.x, y: editorBox.y, button: 'left', clickCount: 1 })
        }
        await sleep(600)
      }
      copied = JSON.parse(clip)
      if (eventData.text === docBytes && (copied.htmlLen ?? 0) > 2000) break
      // 选区没盖到整篇，点回编辑器重来
      for (const type of ['mousePressed', 'mouseReleased']) {
        await renderer.send('Input.dispatchMouseEvent', { type, x: editorBox.x, y: editorBox.y, button: 'left', clickCount: 1 })
      }
      await sleep(400)
    }
    check('大选区复制也带富文本口味',
      gaps > 0 && focused && eventData.html === 0 && (copied.types ?? []).includes('text/html') && copied.htmlLen > 2000,
      `占位=${gaps} 有焦点=${focused} 全文=${docBytes} 字节 事件里 html=${eventData.html} 纯文本=${eventData.text} 剪贴板=${clip}`)
  } finally {
    stopVerifyApp(join(WORK, 'udd-cheatsheet'))
  }
}

function main() {
  return (async () => {
    mkdirSync(WORK, { recursive: true })
    const source = join(WORK, 'features.md')
    writeFileSync(source, fixture(), 'utf8')
    writeFileSync(join(WORK, 'pixel.png'), PIXEL_PNG)

    const port = 9960 + Math.floor(Math.random() * 30)
    const child = spawn('npx', ['electron', 'scripts/offscreen-window.cjs', source, `--user-data-dir=${udd}`,
      `--remote-debugging-port=${port}`
    ], { cwd: APP, stdio: 'ignore', detached: true })

    try {
      const page = await waitTarget(port, (t) => t.type === 'page' && /index\.html/.test(t.url))
      const renderer = await connect(page.webSocketDebuggerUrl)
      // CodeMirror 只为**视口内**的行建 DOM。夹具比一屏长，视口不高的话下半段根本不在
      // DOM 里，会被误判成「没渲染」。先把视口撑到能装下整篇，再量。
      await renderer.send('Emulation.setDeviceMetricsOverride', {
        width: 1200, height: 2600, deviceScaleFactor: 1, mobile: false
      })
      // 等到**这份夹具**真的进了编辑器。只数行数不够：认错了文档时它照样满屏是行，
      // 后面会红一片看不懂的断言（2026-09-26 碰上过一次，18 条一起红）。
      // 片段用正文里的字：属性区一旦按 #138 藏起来，"功能验收" 就不在 DOM 里了。
      let loaded = false
      for (let i = 0; i < 80; i++) {
        const ok = await evaluate(renderer,
          `(() => { const el = document.querySelector('#editor .cm-content'); return el ? el.textContent.includes('一级标题') : false })()`)
        if (ok === true) { loaded = true; break }
        await sleep(250)
      }
      check('夹具已加载', loaded, `编辑器里有没有这份夹具：${loaded}`)
      // mermaid 是异步画的，多等一会儿
      await sleep(2500)

      const m = JSON.parse(await evaluate(renderer, MEASURE))

      check('标题渲染', m.headings.h1 >= 1 && m.headings.h2 >= 1, `h1=${m.headings.h1} h2=${m.headings.h2}`)
      check('标题标记隐藏', m.headings.raw === false, `行里还看得到 #: ${m.headings.raw}`)
      check('行内格式渲染', m.inline.strong >= 1 && m.inline.em >= 1 && m.inline.strike >= 1 && m.inline.code >= 1,
        `strong=${m.inline.strong} em=${m.inline.em} strike=${m.inline.strike} code=${m.inline.code}`)
      check('行内格式标记隐藏', m.inline.raw === false, `还看得到原始标记: ${m.inline.raw}`)
      check('==高亮== 渲染', m.inline.highlight >= 1, `highlight=${m.inline.highlight}`)
      check('时间戳不被当成 emoji 染色', m.timestamp.colors.length === 1,
        `颜色=${JSON.stringify(m.timestamp.colors)} 片段=${JSON.stringify(m.timestamp.spans)}`)
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
      check('表格格子里的 <br/> 画成换行', m.table.brs >= 1, `<br> 个数=${m.table.brs}`)
      check('表格格子里的图片画出来', m.table.imgs >= 1, `格子里 img 个数=${m.table.imgs}`)
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
      check('属性区阅读时不占位置', m.frontmatter.visible === 0,
        `属性区行数=${m.frontmatter.count} 有高度的=${m.frontmatter.visible}`)
      check('脚注渲染', m.footnote.refs >= 1, `refs=${m.footnote.refs} 露源码=${m.footnote.raw}`)
      check('脚注悬停预览', m.footnote.previewCard >= 1, `预览卡片=${m.footnote.previewCard}`)
      check('HTML 块渲染', m.html.rendered >= 1, `rendered=${m.html.rendered} 露源码=${m.html.raw}`)
      // 行内成对标签的 color 生效（#125）：中间的文字必须是红的。
      check('行内 HTML 的 color 生效（#125）', m.inlineColor === 'rgb(255, 0, 0)',
        `红色的字 computed color=${m.inlineColor}`)
      check('导出的 HTML 是语义标签',
        m.exportHtml.strong && m.exportHtml.em && m.exportHtml.anchor && m.exportHtml.list &&
        m.exportHtml.code && m.exportHtml.table && m.exportHtml.quote && m.exportHtml.heading,
        `strong=${m.exportHtml.strong} em=${m.exportHtml.em} a=${m.exportHtml.anchor} ul=${m.exportHtml.list} pre=${m.exportHtml.code} table=${m.exportHtml.table} quote=${m.exportHtml.quote} h1=${m.exportHtml.heading}`)
      check('导出的 HTML 不带编辑器结构',
        m.exportHtml.cmClass === false && m.exportHtml.cmLine === false && m.exportHtml.frontmatter === false,
        `cm-md 类名残留=${m.exportHtml.cmClass}[${m.exportHtml.cmClassNames}] cm-line 残留=${m.exportHtml.cmLine} 属性区残留=${m.exportHtml.frontmatter}`)
      check('导出的 HTML 带图片', m.exportHtml.img === true, `img=${m.exportHtml.img} 长度=${m.exportHtml.size}`)

      // ─── #138 那一批：阅读体验的退化 ─────────────────────────────────────────

      // #138-4：被替换掉的块（表格、图、图片、公式、HTML）点一下要能进去改。
      //
      // 判据 2026-10-06 改过两次：以前是「点完那个替换块消失、源码露出来」。源码现在哪一行
      // 都不露了（要改标记去源码模式），所以判的是「点一下排版还在」。
      // 三个坑都踩过了：①mermaid 是异步画的（走隐藏 iframe，还有 400ms 防抖）；
      // ②把字符打在点击处会把 markdown 语法敲坏（表格那一行就散了），所以先按 End 再打字，
      // 只动行尾；③**一边滚一边等会把它等死**——上面那几条断言做过导出，整篇重渲染过一遍，
      // mermaid 需要重新画，而每 250ms 滚 260px 会让那一行反复进出视口，防抖永远凑不满。
      // 这台机器的视口是 3600px 高，整篇都在里面，等就够了，不用滚。
      // 只覆盖表格与图片：这两种块是同步建的，点一下之后一定还在。
      // mermaid 在这一步等不到（未查明：同一条流水线上它先是渲染好的，见「Mermaid 渲染」，
      // 走到这里却查不到，等 15 秒也不回来；单独开窗实测导出前后它都好好的，所以在夹具这个
      // 场景里是测试自身的问题）。它的渲染另有两条断言盯着，别在这里继续耗时间。
      for (const [label, selector] of [
        ['表格', '.cm-md-table-widget'],
        ['图片', '.cm-md-image'],
      ]) {
        let appeared = false
        for (let i = 0; i < 30; i++) {
          if (Number(await evaluate(renderer, `document.querySelectorAll('${selector}').length`)) > 0) { appeared = true; break }
          await sleep(500)
        }
        const box = JSON.parse(await evaluate(renderer, `(() => {
          const el = document.querySelector('${selector}')
          if (!el) return JSON.stringify({ x: 0, y: 0 })
          const r = el.getBoundingClientRect()
          return JSON.stringify({ x: Math.round(r.left + 12), y: Math.round(r.top + 8) })
        })()`))
        for (const type of ['mousePressed', 'mouseReleased']) {
          if (!box.x) break
          await renderer.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
        }
        await sleep(400)
        const afterClick = Number(await evaluate(renderer, `document.querySelectorAll('${selector}').length`))
        await pressKey(renderer, 'End', 'End', 35)
        await renderer.send('Input.insertText', { text: 'Z' })
        await sleep(500)
        const afterTyping = Number(await evaluate(renderer, `document.querySelectorAll('${selector}').length`))
        await pressKey(renderer, 'z', 'KeyZ', 90, 4)
        await sleep(400)
        check(`${label}点一下不再翻成源码`,
          appeared && afterClick === 1 && afterTyping === 1,
          `渲染块出现=${appeared} 点完=${afterClick} 行尾打字后=${afterTyping}`)
      }

      // 2026-10-08 报：鼠标拖选不到引用块和表格里的文字。这一组用真鼠标事件拖一遍，
      // 看浏览器层真的选中了什么。普通段落当对照组：它要也不动，问题就不在块上，
      // 而在我们自己的鼠标处理把拖动吃掉了。
      const dragAcross = async (token, offset) => {
        const box = JSON.parse(await evaluate(renderer, `(() => {
          const line = [...document.querySelectorAll('#editor .cm-line')].find((l) => l.textContent.includes(${JSON.stringify(token)}))
          if (!line) return 'null'
          const r = line.getBoundingClientRect()
          const x1 = Math.round(r.left + (${offset ?? 6}))
          return JSON.stringify({ x1, x2: Math.round(r.right - 6), y: Math.round(r.top + r.height / 2) })
        })()`))
        if (!box) return { found: false, text: '' }
        await renderer.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x1, y: box.y, button: 'left', clickCount: 1 })
        for (let i = 1; i <= 8; i++) {
          const x = Math.round(box.x1 + ((box.x2 - box.x1) * i) / 8)
          await renderer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: box.y, button: 'left', buttons: 1 })
        }
        await renderer.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x2, y: box.y, button: 'left', clickCount: 1 })
        await sleep(250)
        const text = await evaluate(renderer, `window.getSelection().toString()`)
        return { found: true, text: text ?? '' }
      }
      const drags = {}
      for (const [key, token, offset] of [
        ['paragraph', '普通段落，含', 6],
        ['quote', '引用文字', 6],
        ['table', '列甲', 6],
        ['code', 'const answer = 42', 6],
      ]) {
        drags[key] = await dragAcross(token, offset)
      }
      console.log(`\n拖选实测：${JSON.stringify(Object.fromEntries(Object.entries(drags).map(([k, v]) => [k, v.text.slice(0, 40)])))}\n`)

      // 同一个问题的另两种手法：双击选词、从上一行拖跨进引用块。
      const doubleClickWord = async (token) => {
        const box = JSON.parse(await evaluate(renderer, `(() => {
          const line = [...document.querySelectorAll('#editor .cm-line')].find((l) => l.textContent.includes(${JSON.stringify(token)}))
          if (!line) return 'null'
          const r = line.getBoundingClientRect()
          return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
        })()`))
        if (!box) return ''
        for (const type of ['mousePressed', 'mouseReleased']) {
          await renderer.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 2 })
        }
        await sleep(250)
        return (await evaluate(renderer, `window.getSelection().toString()`)) ?? ''
      }
      const quoteWord = await doubleClickWord('引用文字')
      const paraWord = await doubleClickWord('普通段落，含')
      console.log(`\n双击选词：引用块=${JSON.stringify(quoteWord)} 普通段落=${JSON.stringify(paraWord)}\n`)
      check('双击引用块里的词能选中', quoteWord.length > 0 && quoteWord.includes('引用'),
        `引用块双击选中=${JSON.stringify(quoteWord)}，普通段落双击选中=${JSON.stringify(paraWord)}`)
      check('拖选普通段落能选中（对照组）', (drags.paragraph.text ?? '').includes('普通段落'),
        `选中=${JSON.stringify(drags.paragraph.text.slice(0, 60))}`)
      check('拖选引用块的文字能选中（2026-10-08 报）', (drags.quote.text ?? '').includes('引用文字'),
        `选中=${JSON.stringify(drags.quote.text.slice(0, 60))}`)
      // 表格是替换 widget，预览不参与选择模型（#141）。这条断言记的是现状：哪一天表格里的文字能拖选了，
      // 它会红，那就是该换断言的时候。行内 HTML 上色那一条也是同一个写法。
      check('拖选表格里的文字目前选不到（#141 已知缺口）', !(drags.table.text ?? '').includes('列甲'),
        `选中=${JSON.stringify(drags.table.text.slice(0, 60))}（能选到就说明缺口补上了，请改写这条断言）`)
      check('拖选代码块里的文字', (drags.code.text ?? '').includes('const answer'),
        `选中=${JSON.stringify(drags.code.text.slice(0, 60))}`)

      // #138-5 与 #143：面板打开之后正文必须让开它那一列，而且在剩下的可见区域里居中。
      // 面板是一列浮在窗口上的纸（position: fixed），它不占布局，所以「可见区域」只能靠
      // 窗口减掉面板那一列算出来。这里不动真实的开关状态，只把面板元素显示出来量几何，
      // 免得把「面板默认收起」这件事写进用户的设置里。
      const panelGeometry = async () => JSON.parse(await evaluate(renderer, `(() => {
        const content = document.querySelector('#editor .cm-content').getBoundingClientRect()
        const panel = document.getElementById('file-panel').getBoundingClientRect()
        const left = panel.left <= 4
        const visible = left
          ? { left: panel.right, right: window.innerWidth }
          : { left: 0, right: panel.left }
        return JSON.stringify({
          left: Math.round(left),
          contentLeft: Math.round(content.left),
          contentRight: Math.round(content.right),
          visibleLeft: Math.round(visible.left),
          visibleRight: Math.round(visible.right),
        })
      })()`))
      const measureColumn = async (bodyClass) => {
        await evaluate(renderer, `(() => {
          const panel = document.getElementById('file-panel')
          panel.dataset.wasHidden = panel.hidden ? '1' : ''
          panel.hidden = false
          document.body.classList.add('show-file-panel')
          ${bodyClass ? `document.body.classList.add('${bodyClass}')` : ''}
          return true
        })()`)
        await sleep(400)
        const m = await panelGeometry()
        await evaluate(renderer, `(() => {
          const panel = document.getElementById('file-panel')
          panel.hidden = panel.dataset.wasHidden === '1'
          delete panel.dataset.wasHidden
          document.body.classList.remove('show-file-panel')
          ${bodyClass ? `document.body.classList.remove('${bodyClass}')` : ''}
          return true
        })()`)
        await sleep(200)
        return m
      }
      const describeColumn = (m) => {
        const side = m.left ? '左' : '右'
        return `面板在${side}：正文 ${m.contentLeft}~${m.contentRight}，可见 ${m.visibleLeft}~${m.visibleRight}`
      }
      const clearsPanel = (m) => m.contentRight <= m.visibleRight + 1 && m.contentLeft >= m.visibleLeft - 1
      const centeredInVisible = (m) => Math.abs((m.contentLeft - m.visibleLeft) - (m.visibleRight - m.contentRight)) <= 2
      for (const [dockClass, label] of [[null, '右'], ['panel-left', '左']]) {
        const m = await measureColumn(dockClass)
        check(`面板在${label}：正文不钻到面板底下（#143）`, clearsPanel(m), describeColumn(m))
        check(`面板在${label}：正文在可见区域里居中（#138-5）`, centeredInVisible(m), describeColumn(m))
      }

      // #137：大纲不能把代码块里的 `#` 当成标题。
      // 文件面板默认是收起的（manualHidden 默认真），先按它的开关把它打开。
      await evaluate(renderer, `(() => {
        if (document.getElementById('file-panel').hidden) document.getElementById('file-toggle-btn').click()
        document.getElementById('file-panel-outline').click()
        return true
      })()`)
      await sleep(500)
      const outlineTexts = JSON.parse(await evaluate(renderer,
        `JSON.stringify([...document.querySelectorAll('#outline-list button')].map((b) => b.textContent))`))
      const outlineDiag = JSON.parse(await evaluate(renderer, `JSON.stringify({
        panelHidden: document.getElementById('file-panel').hidden,
        listHidden: document.getElementById('outline-list').hidden,
        rows: document.getElementById('outline-list').children.length,
        active: document.getElementById('file-panel-outline').className
      })`))
      check('大纲不吃代码块里的 #',
        outlineTexts.includes('一级标题') && !outlineTexts.some((t) => t.includes('不该进大纲')),
        `大纲条目=${JSON.stringify(outlineTexts)} 诊断=${JSON.stringify(outlineDiag)}`)
      await evaluate(renderer, `document.getElementById('file-panel-files').click()`)
      await sleep(200)

      // #138-3：查找。按 ⌘F 应该弹出我们自己的面板，敲进去应该真的高亮到。
      for (const type of ['rawKeyDown', 'keyUp']) {
        await renderer.send('Input.dispatchKeyEvent', { type, key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 4 })
      }
      await sleep(500)
      const searchPanelVisible = await evaluate(renderer,
        `(() => { const p = document.querySelector('.search-panel'); return !!(p && p.getBoundingClientRect().height > 0) })()`)
      await evaluate(renderer, `(() => {
        const input = document.querySelector('.search-input')
        if (!input) return false
        input.value = '一级标题'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(600)
      const searchMatches = Number(await evaluate(renderer,
        `document.querySelectorAll('#editor .search-match, #editor .search-match-current').length`))
      const searchCount = await evaluate(renderer,
        `(() => { const el = document.querySelector('.search-count'); return el ? el.textContent : null })()`)
      check('查找能弹面板', searchPanelVisible === true, `面板可见=${searchPanelVisible}`)
      check('查找能高亮到', searchMatches >= 1, `匹配数=${searchMatches} 面板计数=${searchCount}`)

      // 按「下一个」正文要跟着跳（2026-10-03 报的：计数在走，界面不动）。
      // 量这一条必须把视口压回一屏高：验收脚本平时把视口撑到 2600，整篇都渲染出来，
      // 那种情况下每个匹配项都在视野里，滚动是空操作，断言永远不会红。
      await renderer.send('Emulation.setDeviceMetricsOverride', {
        width: 1200, height: 700, deviceScaleFactor: 1, mobile: false
      })
      await sleep(400)
      await evaluate(renderer, `(() => {
        const input = document.querySelector('.search-input')
        input.value = 'NEEL'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await sleep(600)
      await evaluate(renderer, `(() => {
        const btns = [...document.querySelectorAll('.search-btn')]
        const next = btns.find((b) => (b.title || '').includes('下') || (b.title || '').includes('N')) || btns[1]
        next.click()
      })()`)
      let jump = null
      for (let i = 0; i < 25; i++) {
        jump = JSON.parse(await evaluate(renderer, SEARCH_JUMP))
        if (jump.count === '2/2' && jump.scrollTop > 0 && jump.currentVisible === true) break
        await sleep(200)
      }
      check('按「下一个」正文跟着跳', jump.count === '2/2' && jump.scrollTop > 0 && jump.currentVisible === true,
        `计数=${jump.count} 滚动量=${jump.scrollTop} 当前项在DOM里=${jump.currentInDom} 在视野内=${jump.currentVisible} 位置=${JSON.stringify(jump.rect)}`)
      await renderer.send('Emulation.setDeviceMetricsOverride', {
        width: 1200, height: 2600, deviceScaleFactor: 1, mobile: false
      })
      await sleep(300)
      await evaluate(renderer, `(() => { const p = document.querySelector('.search-panel'); if (p) p.remove() })()`)

      // #136：光标停在待办那一行时，复选框不该变回 `- [ ]`。
      await clickLine(renderer, '待办未完成')
      const taskOnActive = JSON.parse(await evaluate(renderer, `(() => {
        const line = [...document.querySelectorAll('#editor .cm-line')].find((l) => l.textContent.includes('待办未完成'))
        return JSON.stringify({
          checkbox: line ? line.querySelectorAll('.cm-md-task, input[type=checkbox]').length : -1,
          text: line ? line.textContent : null
        })
      })()`))
      check('光标停在待办行仍显示复选框', taskOnActive.checkbox >= 1,
        `复选框=${taskOnActive.checkbox} 行=${JSON.stringify(taskOnActive.text)}`)

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
      // 不比逐字节相等：前面的断言会真的改文档（比如点一下待办复选框），拿原文去比就是假红。
      // 这条要证明的是「整篇都拿到了」——长度对得上、头尾都在、中间那段 HTML 块也在。
      const fixtureText = fixture()
      check('全选复制拿到整篇',
        whole.text.length === fixtureText.length &&
        whole.text.startsWith(fixtureText.slice(0, 40)) &&
        whole.text.endsWith(fixtureText.slice(-40)) &&
        whole.text.includes('块</div>'),
        `复制到 ${whole.text.length} 字节，原文 ${fixtureText.length} 字节，` +
        `头=${whole.text.startsWith(fixtureText.slice(0, 40))} 尾=${whole.text.endsWith(fixtureText.slice(-40))} ` +
        `中段=${whole.text.includes('块</div>')}`)

      // 空行只是段落分隔，不许变成 `<p><br></p>`：粘到 Typora 里段落之间会多一行
      //（2026-10-06 报的）。用全选那一份 HTML 看，不用另造选区。
      const gapParagraphs = (whole.html.match(/<p>/g) ?? []).length
      check('复制的 HTML 里空行不留空段落',
        !/<p>\s*<br\s*\/?>\s*<\/p>/i.test(whole.html) && gapParagraphs >= 3,
        `段落数=${gapParagraphs} 空段落=${/<p>\s*<br\s*\/?>\s*<\/p>/i.test(whole.html)} html=${whole.html.slice(0, 200)}`)
      const listTags = (html, tag) => [
        (html.match(new RegExp(`<${tag}(?=[ >])`, 'g')) ?? []).length,
        (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length,
      ]
      const unbalanced = ['ul', 'ol', 'li'].filter((tag) => {
        const [open, close] = listTags(whole.html, tag)
        return open !== close
      })
      check('复制的 HTML 列表结构合法',
        whole.html !== '' && unbalanced.length === 0 && !/<(ul|ol)>(?!<li>)/.test(whole.html),
        `不配对的标签=${unbalanced.join(',') || '无'} html=${whole.html.slice(0, 200)}`)

      // 有序列表的序号：文件里的数就是屏幕上的数。没编辑过就照文件显示（1./3./4.），
      // 增删列表项时把序号写回文件（list-renumber.ts）。曾经试过只改屏幕、不动文件，
      // 被否了：屏幕一旦和文件不一样，复制出去、在 Obsidian 里打开就露馅（2026-10-06）。
      const shownNumbers = JSON.parse(await evaluate(renderer, `JSON.stringify(
        ['有序项一', '有序项二', '有序项三'].map((t) => {
          const line = [...document.querySelectorAll('#editor .cm-line')].find((l) => l.textContent.includes(t))
          return line ? line.textContent : null
        }))`))
      check('序号照文件显示',
        JSON.stringify(shownNumbers) === JSON.stringify(['1. 有序项一', '3. 有序项二', '4. 有序项三']),
        `屏幕上=${JSON.stringify(shownNumbers)}`)
      check('导出的 HTML 记住有序列表的起点',
        whole.html.includes('<ol start="5">') && whole.html.includes('<li>起点为五'),
        `起点那一段=${JSON.stringify(whole.html.slice(Math.max(0, whole.html.indexOf('起点为五') - 30), whole.html.indexOf('起点为五') + 8))}`)

      // 用户报的那一幕：三行有序列表删掉中间一行。屏幕、文件、复制出来的东西必须一致。
      await clickLine(renderer, '有序项二')
      await pressKey(renderer, 'Home', 'Home', 36)
      await pressKey(renderer, 'ArrowDown', 'ArrowDown', 40, 8)
      await pressKey(renderer, 'Backspace', 'Backspace', 8)
      await sleep(400)
      const afterDelete = await evaluate(renderer, `JSON.stringify(
        ['有序项一', '有序项三'].map((t) => {
          const line = [...document.querySelectorAll('#editor .cm-line')].find((l) => l.textContent.includes(t))
          return line ? line.textContent : null
        }))`)
      await evaluate(renderer, SELECT_ALL)
      await sleep(300)
      const deletedSource = JSON.parse(await evaluate(renderer, COPY_PROBE)).text
      check('删掉一项后序号写回文件',
        afterDelete === JSON.stringify(['1. 有序项一', '2. 有序项三']) &&
        deletedSource.includes('2. 有序项三') && !deletedSource.includes('有序项二'),
        `删完屏幕上=${afterDelete} 删完文件里=${JSON.stringify(deletedSource.split('\n').filter((l) => l.includes('有序项')))}`)

      // 撤销一步：删掉的那一项和写回去的序号一起回来，不能只回来一半
      await pressKey(renderer, 'z', 'KeyZ', 90, 4)
      await sleep(500)
      await evaluate(renderer, SELECT_ALL)
      await sleep(300)
      const undoneSource = JSON.parse(await evaluate(renderer, COPY_PROBE)).text
      check('撤销一步回到改前',
        undoneSource.includes('3. 有序项二') && undoneSource.includes('4. 有序项三'),
        `撤销后=${JSON.stringify(undoneSource.split('\n').filter((l) => l.includes('有序项')))}`)

      const perf = await measureKeys(renderer)
      check('30 次光标移动 < 1200ms', perf < 1200, `${perf}ms`)

      // 真鼠标点一下待办复选框：源码里那个 `[ ]` 要变成 `[x]`。
      // 渲染之后源码看不见（被复选框盖住了），所以看「已勾选的数量」是不是多了一个。
      const checkedBefore = await evaluate(renderer, `document.querySelectorAll('.cm-md-task-checked').length`)
      const box = JSON.parse(await evaluate(renderer, `(() => {
        const el = document.querySelector('.cm-md-task')
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
      // 勾选数必须正好变一个（点的是哪个状态就朝哪个方向变），这样夹具里那一项
      // 之前有没有被别的断言勾过都不影响结论。
      check('点击待办能勾选', Math.abs(Number(checkedAfter) - Number(checkedBefore)) === 1,
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

      // 深色主题下选中文字不能被选区色盖住（2026-10-04 报的）。
      await clickLine(renderer, '待办未完成')
      await pressKey(renderer, 'Home', 'Home', 36)
      await pressKey(renderer, 'End', 'End', 35, 8)
      await sleep(400)
      // 色带是 CodeMirror 自己画的图层，第一下量的时候可能还没进 DOM（焦点与重排的时序）。
      // 量不到就重新选一次再量，不能拿 null 当结论（2026-10-07 连续跑时假红过）。
      let selection = JSON.parse(await evaluate(renderer, SELECTION_READABILITY))
      for (let i = 0; i < 6 && selection.band === null; i++) {
        await clickLine(renderer, '待办未完成')
        await pressKey(renderer, 'Home', 'Home', 36)
        await pressKey(renderer, 'End', 'End', 35, 8)
        await sleep(400)
        selection = JSON.parse(await evaluate(renderer, SELECTION_READABILITY))
      }
      check('深色主题下选中文字仍看得清',
        selection.contrast !== null && selection.contrast >= 3 &&
        selection.band === selection.variable,
        `色带=${selection.band} 主题变量=${selection.variable} 底色=${selection.page} 合成后=${selection.effective} 文字=${selection.text} 对比度=${selection.contrast}`)

      // 渲染模式：任何一行都不露源码，但照旧能编辑（2026-10-06 定的）。
      // 返回 JSON 字符串：evaluate 带 returnByValue，返回对象会被 JSON.parse 咬成
      // "[object Object]"（第一次跑就是这么挂的）。
      const RENDER_STATE = `(() => {
        const content = document.querySelector('#editor .cm-content')
        const source = document.getElementById('source-editor')
        return JSON.stringify({
          markers: document.querySelectorAll('#editor .cm-md-marker').length,
          editable: content ? content.isContentEditable : null,
          text: content ? content.textContent.length : -1,
          sourceVisible: source ? source.classList.contains('visible') : null,
          sourceText: source ? source.value : null,
        })
      })()`
      // 光标落在带 **加粗** 的那一行：以前这一行会露源码，现在它也得是干净的。
      await clickLine(renderer, '加粗')
      await sleep(300)
      const clean = JSON.parse(await evaluate(renderer, RENDER_STATE))
      check('渲染模式：光标所在行也不露源码', clean.markers === 0, `marker=${clean.markers}`)
      check('渲染模式：照旧能编辑', clean.editable === true, `contenteditable=${clean.editable}`)
      await renderer.send('Input.insertText', { text: 'X' })
      await sleep(300)
      const typed = JSON.parse(await evaluate(renderer, RENDER_STATE))
      check('渲染模式：打字仍然落进正文', typed.text === clean.text + 1,
        `正文长度 ${clean.text} → ${typed.text}`)
      await pressKey(renderer, 'z', 'KeyZ', 90, 4)
      await sleep(300)
      // 要改标记就去源码模式：整篇都是源码，回来之后渲染照旧是干净的。
      await evaluate(renderer, `(() => { document.getElementById('source-toggle-btn').click(); return true })()`)
      await sleep(500)
      const inSource = JSON.parse(await evaluate(renderer, RENDER_STATE))
      check('源码模式：整篇都是源码，标记看得见',
        inSource.sourceVisible === true && (inSource.sourceText ?? '').includes('**加粗**'),
        `可见=${inSource.sourceVisible} 里面有 **加粗**=${(inSource.sourceText ?? '').includes('**加粗**')}`)
      await evaluate(renderer, `(() => { document.getElementById('source-toggle-btn').click(); return true })()`)
      await sleep(600)
      const back = JSON.parse(await evaluate(renderer, RENDER_STATE))
      // 上面那一下 ⌘Z 已经把打进去的字撤掉了，所以这里比的是 clean.text，不是 clean.text + 1。
      check('切回渲染模式：还是干净的，正文没被改动',
        back.markers === 0 && back.sourceVisible === false && back.text === clean.text,
        `marker=${back.markers} 源码可见=${back.sourceVisible} 正文长度=${back.text}`)

      // ⌘+ / ⌘- 调的是正文字号，界面（顶栏）不许跟着变：整页缩放会让顶栏变高，而 macOS 的
      // 红绿灯是系统画的、尺寸不跟着变，于是放大之后就不居中了（2026-10-06 报的）。
      const GEOMETRY = `(() => {
        const content = document.querySelector('#editor .cm-content')
        const titlebar = document.getElementById('titlebar')
        const panel = document.getElementById('file-list')
        return JSON.stringify({
          contentFont: content ? parseFloat(getComputedStyle(content).fontSize) : null,
          contentFamily: content ? getComputedStyle(content).fontFamily : null,
          titlebarHeight: titlebar ? Math.round(titlebar.getBoundingClientRect().height * 100) / 100 : null,
          fileFont: panel ? parseFloat(getComputedStyle(panel).fontSize) : null,
        })
      })()`
      await clickLine(renderer, '加粗')
      await sleep(200)
      const beforeZoom = JSON.parse(await evaluate(renderer, GEOMETRY))
      await pressKey(renderer, '+', 'Equal', 187, 4 | 8)
      await sleep(500)
      const afterZoom = JSON.parse(await evaluate(renderer, GEOMETRY))
      // 主题自己的字体一个字符都不许变（2026-10-06 报「主题的字体改丢了」）。
      check('⌘+ 只放大正文字号，界面不动',
        afterZoom.contentFont === beforeZoom.contentFont + 1 &&
        afterZoom.titlebarHeight === beforeZoom.titlebarHeight,
        `正文字号 ${beforeZoom.contentFont} → ${afterZoom.contentFont}，顶栏高度 ${beforeZoom.titlebarHeight} → ${afterZoom.titlebarHeight}`)
      check('⌘+ 不动主题的字体族',
        afterZoom.contentFamily === beforeZoom.contentFamily,
        `字体族 ${JSON.stringify(beforeZoom.contentFamily)} → ${JSON.stringify(afterZoom.contentFamily)}`)
      await pressKey(renderer, '0', 'Digit0', 48, 4)
      await sleep(500)
      const afterReset = JSON.parse(await evaluate(renderer, GEOMETRY))
      check('⌘0 把正文字号恢复成默认',
        afterReset.contentFont === beforeZoom.contentFont && afterReset.contentFamily === beforeZoom.contentFamily,
        `字号 ${afterZoom.contentFont} → ${afterReset.contentFont}（默认 ${beforeZoom.contentFont}），字体族 ${JSON.stringify(afterReset.contentFamily)}`)

      const failed = checks.filter((c) => !c.ok)
      for (const c of checks) {
        console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : `  ← ${c.detail}`}`)
      }
      console.log(failed.length
        ? `\n✗ ${failed.length}/${checks.length} 条没通过`
        : `\n✓ ${checks.length} 条全通过`)
      if (failed.length) process.exitCode = 1
    } finally {
      stopVerifyApp(udd)
      await sleep(300)
      rmSync(WORK, { recursive: true, force: true })
    }
  })()
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exitCode = 1
})
