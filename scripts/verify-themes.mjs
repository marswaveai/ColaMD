#!/usr/bin/env node
// 主题验收：`themes/*.css` 里的每一条规则都必须**命中真实的 DOM 元素**，并且真的改变
// 至少一个属性。内置主题的 `body.theme-*` 规则也在检查范围内。
//
// 为什么需要它：换编辑器内核的时候，Milkdown/ProseMirror 的 DOM 没了，根目录 `themes/`
// 里 10 套主题还留着一堆 `#editor .ProseMirror strong { … }`，选择器永远匹配不到东西，
// 于是「下载了主题，加粗和标题的颜色却没变」。这类失效不会报错、不会崩溃，肉眼也只在
// 换主题的瞬间才看得出来，所以它必须有断言：没人用的选择器 = 红。
//
// 判据（两条，都是机械的）：
//   1. 每条规则至少命中一个元素。命中 0 个说明它描述了一个不存在的结构。
//   2. 每个主题至少有一条规则能真的改变计算样式。都不变说明这个主题是个空壳。
// 效果的判定方式是把规则单独注入、开关一次，比较命中元素的计算样式快照。这样不用在
// 测试里抄一遍颜色值，主题改了测试不用跟着改。
//
// 用法: npm run verify:themes（先 npm run build）
// 窗口放在屏幕外，不占用屏幕。
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

const APP = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
assertBuildFresh()
const { dir: WORK, udd } = verifyWorkdir('themes')
const THEMES = join(APP, 'themes')

/** 夹具要装下主题会碰的每一种元素，缺一种就会把主题误判成失效。 */
function fixture() {
  return [
    '# 一级标题',
    '',
    '## 二级标题',
    '',
    '### 三级标题',
    '',
    '#### 四级标题',
    '',
    '正文里有 **加粗**、`行内代码`、[一个链接](https://example.com/docs) 和 ~~删除线~~。',
    '',
    '另见裸链接 https://example.com/bare 这一段。',
    '',
    '> 引用的第一行',
    '> 引用的第二行',
    '',
    '| 表头甲 | 表头乙 |',
    '| --- | --- |',
    '| 单元格甲 | 单元格乙 |',
    '',
    '---',
    '',
    '```js',
    'const answer = 42',
    '```',
    '',
    '- 无序项甲',
    '- 无序项乙',
    '',
    '1. 有序项甲',
    '2. 有序项乙',
    '',
    '行内公式 $a^2+b^2=c^2$ 与行尾文本。',
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
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400))
    return result.result?.value
  })
}

/**
 * 页内探针。
 *
 * 每个进程只装一次。它做三件事：
 *   - 把待测 CSS 拆成「一条规则一张表」，全部禁用后按需开关，量一条规则的净效果；
 *   - 变量规则（声明全是 `--x`）不看计算样式，看变量在 html 与 body 上是不是真的取到了那个值；
 *   - 别的规则查命中数 + 比计算样式快照。
 *
 * 单独成表是为了隔离：同一套主题里几条规则可能命中同一个元素，整表开关量不出是哪条在起作用。
 */
const PROBE = `(() => {
  const PROBE_ATTR = 'data-theme-probe'
  for (const el of document.querySelectorAll('style[' + PROBE_ATTR + ']')) el.remove()
  const sheets = []

  window.__themeProbe = {
    /** 装入一份待测 CSS，返回每条规则的编号，同时把它们的表建好（默认全禁用）。 */
    load(css) {
      for (const s of sheets) s.el.remove()
      sheets.length = 0
      const parsed = document.createElement('style')
      parsed.setAttribute(PROBE_ATTR, 'parse')
      parsed.textContent = css
      document.head.appendChild(parsed)
      const list = [...parsed.sheet.cssRules]
      parsed.remove()
      list.forEach((rule, index) => {
        const el = document.createElement('style')
        el.setAttribute(PROBE_ATTR, String(index))
        el.textContent = rule.cssText
        // 变量规则一直开着：别的规则可能用 var() 引用它们，变量缺席时那条规则量出来是
        // 「没效果」，会被误判成失效。
        const isVars = rule.style && rule.style.length > 0 && [...rule.style].every((p) => p.startsWith('--'))
        document.head.appendChild(el)
        // 先插入再禁用：元素进文档之前写 disabled 没有任何效果，sheet 会在插入时新建出来
        // 并保持启用（这里踩过一次，12 个主题的「与默认值相同」全是假绿）。
        if (!isVars) el.disabled = true
        sheets.push({ el, rule, index, isVars })
      })
      return list.length
    },

    /** 一条规则的信息 + 命中数。 */
    describe(index) {
      const entry = sheets.find((s) => s.index === index)
      const rule = entry.rule
      if (rule.selectorText === undefined) return { selector: rule.cssText.slice(0, 40), kind: 'at', matches: -1 }
      const selector = rule.selectorText
      const vars = [...rule.style].every((p) => p.startsWith('--')) && rule.style.length > 0
      if (vars) {
        const html = getComputedStyle(document.documentElement)
        const body = getComputedStyle(document.body)
        const declared = [...rule.style].map((p) => [p, rule.style.getPropertyValue(p).trim()])
        const wrong = declared.filter(([p, v]) =>
          html.getPropertyValue(p).trim() !== v || body.getPropertyValue(p).trim() !== v)
        return { selector, kind: 'vars', matches: 1, declared: declared.length, wrong: wrong.map(([p, v]) => p + '=' + v) }
      }
      if (/:hover|:focus|::|:has\\(/.test(selector)) return { selector, kind: 'interactive', matches: -2 }
      const nodes = [...document.querySelectorAll(selector)]
      return { selector, kind: 'rule', matches: nodes.length }
    },

    /** 开关这一条规则，返回计算样式变化的属性条数与几个例子。 */
    measure(index, limit = 3) {
      const entry = sheets.find((s) => s.index === index)
      const nodes = [...document.querySelectorAll(entry.rule.selectorText)].slice(0, limit)
      if (nodes.length === 0) return { changed: 0, sample: [] }
      const before = nodes.map(snapshot)
      entry.el.disabled = false
      const after = nodes.map(snapshot)
      entry.el.disabled = true
      let changed = 0
      const sample = []
      for (let i = 0; i < nodes.length; i++) {
        for (const prop of Object.keys(after[i])) {
          if (before[i][prop] !== after[i][prop]) {
            changed++
            if (sample.length < 3) sample.push(prop + ': ' + before[i][prop] + ' → ' + after[i][prop])
          }
        }
      }
      return { changed, sample }
    },

    /** 内置主题：在应用自己的样式表里找出 body.theme-* 规则，逐条查命中数。 */
    builtin() {
      const found = []
      for (const sheet of document.styleSheets) {
        let rules = null
        try { rules = sheet.cssRules } catch { continue }
        for (const rule of rules) {
          const selector = rule.selectorText
          if (!selector || !/body\\.theme-[a-z-]+/.test(selector)) continue
          if (/:hover|:focus|::/.test(selector)) continue
          found.push({ theme: selector.match(/body\\.theme-([a-z-]+)/)[1], selector })
        }
      }
      // 命中数要在对应的主题类下量：规则本来就写成 body.theme-x … 的形式，
      // 不挂上那个类，每一条都会「命中不到任何元素」。
      const out = {}
      const keep = document.body.className
      for (const entry of found) {
        const stat = out[entry.theme] ?? (out[entry.theme] = { rules: 0, empty: [] })
        stat.rules++
        document.body.className = keep.replace(/theme-[a-z-]+/g, '').trim() + ' theme-' + entry.theme
        if (document.querySelectorAll(entry.selector).length === 0) {
          stat.empty.push(entry.selector.replace(/body\\.theme-[a-z-]+ ?/g, ''))
        }
      }
      document.body.className = keep
      return out
    }
  }

  function snapshot(el) {
    const cs = getComputedStyle(el)
    const out = {}
    for (const prop of cs) out[prop] = cs.getPropertyValue(prop)
    return out
  }

  // 应用的主题类由测试脚本接管：这里只保证有 theme-custom，内置主题类全部摘掉，
  // 复现「用户下载了主题文件」的那条路径。
  document.body.className = document.body.className.replace(/theme-[a-z-]+/g, '').trim()
  document.body.classList.add('theme-custom')
  return true
})()`

async function main() {
  mkdirSync(WORK, { recursive: true })
  const source = join(WORK, 'themes.md')
  writeFileSync(source, fixture(), 'utf8')

  const files = readdirSync(THEMES).filter((f) => f.endsWith('.css')).sort()
  const contents = new Map(files.map((f) => [f, readFileSync(join(THEMES, f), 'utf8')]))

  const port = 9990 + Math.floor(Math.random() * 30)
  const child = spawn('npx', ['electron', 'scripts/offscreen-window.cjs', source, `--user-data-dir=${udd}`,
    `--remote-debugging-port=${port}`
  ], { cwd: APP, stdio: 'ignore', detached: true })

  let failures = 0
  const fail = (message) => { failures++; console.log(`  ✗ ${message}`) }

  try {
    const page = await waitTarget(port, (t) => t.type === 'page' && /index\.html/.test(t.url))
    const renderer = await connect(page.webSocketDebuggerUrl)
    // CodeMirror 只为视口内的行建 DOM。夹具比一屏长，视口不够高的话下半段根本不渲染。
    await renderer.send('Emulation.setDeviceMetricsOverride', {
      width: 1200, height: 2600, deviceScaleFactor: 1, mobile: false
    })
    let loaded = false
    for (let i = 0; i < 80; i++) {
      const ok = await evaluate(renderer, `(() => {
        const el = document.querySelector('#editor .cm-content')
        return el ? el.textContent.includes('一级标题') && el.querySelector('.cm-md-table-header .cm-md-table-cell') !== null
          && el.querySelector('.cm-md-url') !== null : false
      })()`)
      if (ok === true) { loaded = true; break }
      await sleep(250)
    }
    if (!loaded) throw new Error('夹具没进编辑器（或表格 widget 没渲染出来）')

    await evaluate(renderer, PROBE)

    console.log(`独立主题文件（${files.length} 个）`)
    for (const file of files) {
      const total = await evaluate(renderer, `window.__themeProbe.load(${JSON.stringify(contents.get(file))})`)
      let effective = 0
      const skipped = []
      for (let index = 0; index < total; index++) {
        const info = await evaluate(renderer, `JSON.stringify(window.__themeProbe.describe(${index}))`)
        const rule = JSON.parse(info)
        if (rule.kind === 'at') continue
        if (rule.kind === 'interactive') { skipped.push(rule.selector); continue }
        if (rule.kind === 'vars') {
          if (rule.wrong.length > 0) fail(`${file}: 变量没生效 ${rule.wrong.join(' ')}`)
          else effective++
          continue
        }
        if (rule.matches === 0) {
          fail(`${file}: 命中不到任何元素 ${rule.selector}`)
          continue
        }
        const result = JSON.parse(await evaluate(renderer, `JSON.stringify(window.__themeProbe.measure(${index}))`))
        if (result.changed > 0) effective++
        else skipped.push(rule.selector)
      }
      const note = skipped.length > 0 ? `，另有 ${skipped.length} 条当前量不出差别（${skipped.join('、')}）` : ''
      console.log(`  ${effective > 0 ? '✓' : '✗'} ${file}：${total} 条规则，${effective} 条确有作用${note}`)
      if (effective === 0) fail(`${file}: 没有任何一条规则在起作用，这个主题是个空壳`)
    }

    console.log('内置主题（应用样式表里的 body.theme-* 规则）')
    const builtin = JSON.parse(await evaluate(renderer, `JSON.stringify(window.__themeProbe.builtin())`))
    for (const [theme, info] of Object.entries(builtin).sort()) {
      if (info.empty.length > 0) fail(`theme-${theme}: 命中不到任何元素 ${info.empty.join(' | ')}`)
      else console.log(`  ✓ theme-${theme}：${info.rules} 条规则全部命中`)
    }
  } finally {
    stopVerifyApp(udd)
  }

  console.log(failures === 0 ? '\n主题验收通过 ✓' : `\n主题验收失败：${failures} 项`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
