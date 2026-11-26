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
  Home: { key: 'Home', code: 'Home', vkc: 36 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vkc: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vkc: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vkc: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vkc: 40 },
  KeyZ: { key: 'z', code: 'KeyZ', vkc: 90 },
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
  { name: '松散列表回车不凭空多插空行', doc: '1. 甲\n\n2. 乙', cursor: (d) => [d.length], keys: ['Enter'], expect: '1. 甲\n\n2. 乙\n3. ', expectHead: (d) => d.length },
  { name: '文档末尾隔一行回车', doc: '- 甲\n\n', cursor: (d) => [at(d, '甲') + 1], keys: ['Enter'], expect: '- 甲\n- \n\n' },
  // 「多空格」的嫌疑：标记后本来就多打了空格的项
  { name: '标记后多空格续行不多留空格', doc: '-   甲', cursor: (d) => [d.length], keys: ['Enter'], observe: '' },
  // 渲染模式下标记隐藏，正文首字前退格必须干净拆标记或退缩进，绝不留下 2/4 个空格（2026-11-11）
  { name: '标记后按退格干净拆标记不留空格', doc: '- 甲', cursor: (d) => [at(d, '甲')], keys: ['Backspace'], expect: '甲', expectHead: () => 0 },
  { name: '二级列表首字前退格退成一级不留四空格', doc: '- 甲\n  - 乙', cursor: (d) => [at(d, '乙')], keys: ['Backspace'], expect: '- 甲\n- 乙', expectHead: (d) => at(d, '乙') },
  { name: '三级列表首字前退格退成二级', doc: '- 甲\n  - 乙\n    - 丙', cursor: (d) => [at(d, '丙')], keys: ['Backspace'], expect: '- 甲\n  - 乙\n  - 丙', expectHead: (d) => at(d, '丙') },
  // 有序列表退格契约（2026-11-20 橘子拍板）：
  // 第一项首字前退格 -> 第一行取消列表格式，下方立刻变成 1. / 2. 且格式不丢；
  // 非首项首字前退格 -> 不拆成中间普通行，直接合并到上一项末尾并顺延下方。
  { name: '有序列表首项退格取消第一行格式且下方归 1.', doc: '1. 测试\n2. 测试\n3. ', cursor: (d) => [at(d, '测试')], keys: ['Backspace'], expect: '测试\n1. 测试\n2. ', expectHead: () => 0 },
  { name: '普通段落下方删掉整行 1. 下方立刻归 1.', doc: '测试\n1. 第一条\n2. 测试\n3. ', cursor: (d) => [at(d, '1. 第一条'), at(d, '2. 测试')], keys: ['Backspace'], expect: '测试\n1. 测试\n2. ' },
  { name: '有序列表非首项首字前退格直接合并到上一项', doc: '1. 甲\n2. 乙\n3. 丙', cursor: (d) => [at(d, '乙')], keys: ['Backspace'], expect: '1. 甲乙\n2. 丙', expectHead: (d) => at(d, '乙') },
  { name: '有序列表非首空项首字前退格删空项回上行末', doc: '1. 甲\n2. \n3. 丙', cursor: (d) => [at(d, '2. ') + 3], keys: ['Backspace'], expect: '1. 甲\n2. 丙', expectHead: (d) => at(d, '\n2. 丙') },
  // 孤立空首项 `1. ` 按回车保留 1. 并续 2.；再按回车删除 2. 保留 1.（2026-11-20 橘子拍板）
  { name: '敲完 1. 空格直接回车保留 1. 并出 2.', doc: '1. ', cursor: (d) => [d.length], keys: ['Enter'], expect: '1. \n2. ', expectHead: (d) => d.length },
  { name: '普通文字下方敲 1. 空格直接回车保留 1. 并出 2.', doc: '测试\n1. ', cursor: (d) => [d.length], keys: ['Enter'], expect: '测试\n1. \n2. ', expectHead: (d) => d.length },
  { name: '1. 回车出 2. 后第二次回车删除 2. 保留 1.', doc: '1. ', cursor: (d) => [d.length], keys: ['Enter', 'Enter'], expect: '1. \n', expectHead: (d) => d.length },
  { name: '有内容项后连按两次回车退出列表', doc: '1. 甲', cursor: (d) => [d.length], keys: ['Enter', 'Enter'], expect: '1. 甲\n', expectHead: (d) => d.length },
  // 隔着空行彼此独立，都从 1. 起算（2026-11-20 橘子拍板）
  { name: '隔着空行敲 1. 空格保持 1. 不跨空行联动', doc: '1. 甲\n2. 乙\n\n1.', cursor: (d) => [d.length], type: ' ', expect: '1. 甲\n2. 乙\n\n1. ', expectHead: (d) => d.length },
  { name: '中间空项回车退出形成空行后下方归 1.', doc: '1. 甲\n2. \n3. 丙', cursor: (d) => [at(d, '2. ') + 3], keys: ['Enter'], expect: '1. 甲\n\n1. 丙', expectHead: () => 5 },
  { name: '紧贴上一项敲 1. 空格顺延成下一号', doc: '1. 甲\n1.', cursor: (d) => [d.length], type: ' ', expect: '1. 甲\n2. ', expectHead: (d) => d.length },
  // 有序列表高级结构：进位护缩进、带子列表行尾回车、子树联动、首项禁 Tab、多行选区 Tab、软换行
  { name: '9. 涨成 10. 时旧 3 空格子项自动补缩进不脱钩', doc: '8. 甲\n9. 乙\n   1. 子', cursor: (d) => [at(d, '甲') + 1], keys: ['Enter'], expect: '8. 甲\n9. \n10. 乙\n    1. 子' },
  { name: '带子列表的父项行尾回车插入为第一条子项', doc: '1. 甲\n    1. 子1\n2. 乙', cursor: (d) => [at(d, '甲') + 1], keys: ['Enter'], expect: '1. 甲\n    1. \n    2. 子1\n2. 乙', expectHead: (d) => at(d, '    1. ') + 7 },
  { name: '有序项正文首字前回车在上方插空项原项顺延', doc: '1. 甲\n2. 乙', cursor: (d) => [at(d, '甲')], keys: ['Enter'], expect: '1. \n2. 甲\n3. 乙', expectHead: (d) => at(d, '甲') },
  // 无序项同理；上方新项必须保留标记后的空格，否则 `-` 不再算列表
  { name: '无序项正文首字前回车在上方插空项', doc: '正文\n\n- 甲\n- 乙', cursor: (d) => [at(d, '甲')], keys: ['Enter'], expect: '正文\n\n- \n- 甲\n- 乙', expectHead: (d) => at(d, '甲') },
  { name: '引用里无序项首字前回车保留 > 与空格', doc: '> - 甲', cursor: (d) => [at(d, '甲')], keys: ['Enter'], expect: '> - \n> - 甲', expectHead: (d) => at(d, '甲') },
  { name: '嵌套无序项首字前回车保留缩进', doc: '- 甲\n  * 乙', cursor: (d) => [at(d, '乙')], keys: ['Enter'], expect: '- 甲\n  * \n  * 乙', expectHead: (d) => at(d, '乙') },
  { name: '待办首字前回车在上方插未勾选空项', doc: '- [x] 甲', cursor: (d) => [at(d, '甲')], keys: ['Enter'], expect: '- [ ] \n- [x] 甲', expectHead: (d) => at(d, '甲') },
  { name: '子列表首项 Shift+Tab 退级后留下的子项归 1.', doc: '1. 甲\n    1. 乙\n    2. 丙', cursor: (d) => [at(d, '乙')], keys: [['Tab', 8]], expect: '1. 甲\n2. 乙\n    1. 丙', expectHead: (d) => at(d, '乙') },
  { name: '嵌套空子项回车先退一级成上层同级项', doc: '1. 甲\n    1. 乙\n    2. ', cursor: (d) => [d.length], keys: ['Enter'], expect: '1. 甲\n    1. 乙\n2. ', expectHead: (d) => d.length },
  { name: '带子列表父项 Tab 缩进时整棵子树联动', doc: '1. 甲\n2. 乙\n    1. 子1', cursor: (d) => [at(d, '乙')], keys: ['Tab'], expect: '1. 甲\n    1. 乙\n        1. 子1', expectHead: (d) => at(d, '乙') },
  { name: '带子列表父项 Shift+Tab 退级时整棵子树联动', doc: '1. 甲\n    1. 乙\n        1. 子1', cursor: (d) => [at(d, '乙')], keys: [['Tab', 8]], expect: '1. 甲\n2. 乙\n    1. 子1', expectHead: (d) => at(d, '乙') },
  { name: '有序列表第一项按 Tab 不缩进成代码块', doc: '1. 甲\n2. 乙', cursor: (d) => [at(d, '甲')], keys: ['Tab'], expect: '1. 甲\n2. 乙', expectHead: (d) => at(d, '甲') },
  { name: '多行选区按 Tab 批量缩进且不删选区变制表符', doc: '1. 甲\n2. 乙\n3. 丙', cursor: (d) => [at(d, '乙'), d.length], keys: ['Tab'], expect: '1. 甲\n    1. 乙\n    2. 丙' },
  { name: '有序列表 Shift+Enter 项内软换行对齐正文', doc: '1. 甲', cursor: (d) => [d.length], keys: [['Enter', 8]], expect: '1. 甲\n   ', expectHead: (d) => d.length },
  { name: '圆括号有序列表 1) 续行保持圆括号', doc: '1) 甲\n2) 乙', cursor: (d) => [d.length], keys: ['Enter'], expect: '1) 甲\n2) 乙\n3) ', expectHead: (d) => d.length },
  // 光标导航守护：Home / ArrowLeft / ArrowRight 绝不落进 `1.` 内部或左边
  { name: '有序项 Home 落在正文首字前不落 1. 左边', doc: '1. 甲乙', cursor: (d) => [d.length], keys: ['Home'], expect: '1. 甲乙', expectHead: (d) => at(d, '甲') },
  { name: '有序项首字前按左键直达上一行末不卡前缀', doc: '1. 甲\n2. 乙', cursor: (d) => [at(d, '乙')], keys: ['ArrowLeft'], expect: '1. 甲\n2. 乙', expectHead: (d) => at(d, '\n2. 乙') },
  { name: '上一行末按右键一步跨过 2. 落正文首字前', doc: '1. 甲\n2. 乙', cursor: (d) => [at(d, '\n2. 乙')], keys: ['ArrowRight'], expect: '1. 甲\n2. 乙', expectHead: (d) => at(d, '乙') },
  { name: '有序首项首字前按左键停在正文首字前不左越', doc: '1. 甲', cursor: (d) => [at(d, '甲')], keys: ['ArrowLeft'], expect: '1. 甲', expectHead: (d) => at(d, '甲') },
  // 刚敲 `1.` 尚未敲空格不能被提前改成上一条续号，也不能跨顶格段落续号（2026-11-11）
  { name: '敲 1. 未敲空格不提前续号', doc: '1. 甲\n2. 乙\n1', cursor: (d) => [d.length], type: '.', expect: '1. 甲\n2. 乙\n1.' },
  { name: '隔着顶格普通段落新起 1. 不跨段续号', doc: '1. 甲\n2. 乙\n普通段落\n1.', cursor: (d) => [d.length], type: ' 新表', expect: '1. 甲\n2. 乙\n普通段落\n1. 新表' },
  { name: '退出列表顶格打字后再回车不补缩进', doc: '- 甲\n普通段落', cursor: (d) => [d.length], keys: ['Enter'], expect: '- 甲\n普通段落\n', expectHead: (d) => d.length },
  // 引用套列表（2026-11-11）：Tab / Shift+Tab / 退格 / 空行退出都必须认行首 `> `
  { name: '引用内列表 Tab 缩进落在 > 后不炸代码块', doc: '> - 甲\n> - 乙', cursor: (d) => [at(d, '乙')], keys: ['Tab'], expect: '> - 甲\n>   - 乙', expectHead: (d) => at(d, '乙') },
  { name: '引用内二级列表 Shift+Tab 退回一级', doc: '> - 甲\n>   - 乙', cursor: (d) => [at(d, '乙')], keys: [['Tab', 8]], expect: '> - 甲\n> - 乙', expectHead: (d) => at(d, '乙') },
  { name: '引用内二级列表首字前退格退回一级', doc: '> - 甲\n>   - 乙', cursor: (d) => [at(d, '乙')], keys: ['Backspace'], expect: '> - 甲\n> - 乙', expectHead: (d) => at(d, '乙') },
  { name: '引用内一级列表首字前退格拆标记保留引用', doc: '> - 甲\n> - 乙', cursor: (d) => [at(d, '乙')], keys: ['Backspace'], expect: '> - 甲\n> 乙', expectHead: (d) => at(d, '乙') },
  { name: '引用内待办方框后退格只拆框保留 > - ', doc: '> - [ ] 甲', cursor: (d) => [at(d, '甲')], keys: ['Backspace'], expect: '> - 甲', expectHead: (d) => at(d, '甲') },
  { name: '引用内空列表项回车退回空引用行', doc: '> - 甲\n> - ', cursor: (d) => [d.length], keys: ['Enter'], expect: '> - 甲\n> ' },
  { name: '空引用行单次回车直接退出引用', doc: '> 甲\n> ', cursor: (d) => [d.length], keys: ['Enter'], expect: '> 甲\n', expectHead: (d) => d.length }
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

    // 右键要一次跨过整个复选框，不是一格一格挪（含引用内的待办）
    await setDoc('- [ ] 甲')
    await setCursor(0)
    await press(renderer, 'ArrowRight')
    const head = await headOf()
    check('右键一次跨过待办方框', head === 6, `光标落在 ${head}，应在 6（甲的起点）`)

    await setDoc('> - [ ] 甲')
    await setCursor(2)
    await press(renderer, 'ArrowRight')
    const quotedTaskHead = await headOf()
    check('引用内右键一次跨过待办方框', quotedTaskHead === 8, `光标落在 ${quotedTaskHead}，应在 8（甲的起点）`)

    const quotedTaskBox = JSON.parse(await evaluate(renderer, `(() => {
      const cb = document.querySelector('#editor .cm-md-task')
      if (!cb) return 'null'
      const r = cb.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`))
    if (quotedTaskBox) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await renderer.send('Input.dispatchMouseEvent', { type, x: quotedTaskBox.x, y: quotedTaskBox.y, button: 'left', clickCount: 1 })
      }
      await sleep(160)
    }
    check('引用内点击待办复选框切换勾选', (await docOf()) === '> - [x] 甲', `文档=${JSON.stringify(await docOf())}`)

    // --- 渲染层与 DOM 几何实测（2026-11-20 新增） ---
    const lineClassesOf = () => evaluate(renderer, `[...document.querySelectorAll('#editor .cm-line')].map((l) => l.className)`)

    // 1. 普通文字下面敲 `1. `（尚未打字），空格落下那一瞬间立刻出现列表格式 `.cm-md-li-0`
    await setDoc('测试\n1.')
    await setCursor(5)
    const beforeSpaceCls = await lineClassesOf()
    check('敲完 1. 尚未敲空格时不提前出列表格式', !beforeSpaceCls[1].includes('cm-md-li'), JSON.stringify(beforeSpaceCls))
    await renderer.send('Input.insertText', { text: ' ' })
    await sleep(160)
    const afterSpaceCls = await lineClassesOf()
    check('普通文字下方敲 1. 空格立刻出列表格式无需打字',
      (await docOf()) === '测试\n1. ' && afterSpaceCls[1].includes('cm-md-li-0') && afterSpaceCls[1].includes('cm-md-li-ordered'),
      `文档=${JSON.stringify(await docOf())} 类=${JSON.stringify(afterSpaceCls)}`)

    // 1b. 普通文字下面敲 `-`：上一行不变 H2、`-` 可见不消失；再敲空格立刻变单个圆点 `•` 且不残留横杆、不出双圆点
    await setDoc('新增付费用户\n')
    await setCursor(7)
    await renderer.send('Input.insertText', { text: '-' })
    await sleep(160)
    const afterDash = JSON.parse(await evaluate(renderer, `(() => {
      const lines = [...document.querySelectorAll('#editor .cm-line')]
      const h1 = lines[0]
      const h2 = lines[1]
      return JSON.stringify({
        line0Class: h1 ? h1.className : '',
        line0FontSize: h1 ? parseFloat(getComputedStyle(h1).fontSize) : 0,
        line0Text: h1 ? h1.textContent : '',
        line1Text: h2 ? h2.textContent : '',
        line1Class: h2 ? h2.className : '',
        bullets: h2 ? h2.querySelectorAll('.cm-md-li-bullet').length : 0,
      })
    })()`))
    check('普通文字下方敲 - 不变 H2 且横杆可见不消失',
      (await docOf()) === '新增付费用户\n-' &&
      !afterDash.line0Class.includes('heading') &&
      afterDash.line0FontSize > 0 && afterDash.line0FontSize < 24 &&
      afterDash.line1Text === '-' &&
      !afterDash.line1Class.includes('cm-md-li') &&
      afterDash.bullets === 0,
      JSON.stringify(afterDash))

    await renderer.send('Input.insertText', { text: ' ' })
    await sleep(160)
    const afterDashSpace = JSON.parse(await evaluate(renderer, `(() => {
      const lines = [...document.querySelectorAll('#editor .cm-line')]
      const line1 = lines[1]
      return JSON.stringify({
        line1Text: line1 ? line1.textContent : '',
        line1Class: line1 ? line1.className : '',
        bullets: line1 ? line1.querySelectorAll('.cm-md-li-bullet').length : 0,
      })
    })()`))
    check('普通文字下方敲 - 空格立刻变单个圆点无横杆',
      (await docOf()) === '新增付费用户\n- ' &&
      afterDashSpace.line1Class.includes('cm-md-li-0') &&
      afterDashSpace.bullets === 1 &&
      !afterDashSpace.line1Text.includes('-'),
      JSON.stringify(afterDashSpace))

    // 1c. 同行敲 `- - ` 只渲染行首 1 个圆点，绝不并排出现两个圆点
    await setDoc('- - 测试')
    await setCursor(6)
    await sleep(160)
    const doubleDashBullets = await evaluate(renderer, `document.querySelector('#editor .cm-line').querySelectorAll('.cm-md-li-bullet').length`)
    check('同行 `- - ` 只画一个圆点不并排出现两个圆点', doubleDashBullets === 1, `圆点数=${doubleDashBullets}`)

    // 2. 删掉 1. 测试 的 1. 后，下面 2. 测试 / 3. 立刻变 1. 测试 / 2. 且 DOM 保持列表格式不丢
    await setDoc('1. 测试\n2. 测试\n3. ')
    await setCursor(3)
    await press(renderer, 'Backspace')
    const afterUnlistCls = await lineClassesOf()
    check('取消第一行列表格式后下面两行归 1./2. 且 DOM 保留列表格式',
      (await docOf()) === '测试\n1. 测试\n2. ' &&
      !afterUnlistCls[0].includes('cm-md-li') &&
      afterUnlistCls[1].includes('cm-md-li-0') &&
      afterUnlistCls[2].includes('cm-md-li-0'),
      `文档=${JSON.stringify(await docOf())} 类=${JSON.stringify(afterUnlistCls)}`)

    // 3. 鼠标直接点在有序列表行左侧 `1.` 上，光标落到正文首字前，打字绝不写出 `X1. 甲`
    await setDoc('1. 甲\n2. 乙')
    await setCursor(8)
    const numMarkPos = JSON.parse(await evaluate(renderer, `(() => {
      const m = document.querySelector('#editor .cm-md-li-ordered .cm-md-listmark')
      if (!m) return 'null'
      const r = m.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2) })
    })()`))
    if (numMarkPos) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await renderer.send('Input.dispatchMouseEvent', { type, x: numMarkPos.x, y: numMarkPos.y, button: 'left', clickCount: 1 })
      }
      await sleep(160)
    }
    const afterClickHead = await headOf()
    await renderer.send('Input.insertText', { text: 'X' })
    await sleep(160)
    check('鼠标点在 1. 序号上光标自动落正文首字前不伤序号',
      afterClickHead === 3 && (await docOf()) === '1. X甲\n2. 乙',
      `点后光标=${afterClickHead} 打字后=${JSON.stringify(await docOf())}`)

    // 4. 一次 Cmd+Z 撤销：合并/重排一起还原
    await setDoc('1. 测试\n2. 测试\n3. 结尾')
    await setCursor(3)
    await press(renderer, 'Backspace')
    const afterCancel = await docOf()
    await press(renderer, 'KeyZ', 4) // Meta+Z
    const afterUndo = await docOf()
    check('取消首项格式并重排后一次撤销完整还原',
      afterCancel === '测试\n1. 测试\n2. 结尾' && afterUndo === '1. 测试\n2. 测试\n3. 结尾',
      `取消后=${JSON.stringify(afterCancel)} 撤销后=${JSON.stringify(afterUndo)}`)

    // 5. 悬挂缩进真 DOM 坐标测量：长句折行后，第 2 行左边缘位于 `1.` 右侧，靠近正文首字
    const longOrdered = '1. ' + '这是一段专门用于真窗口实测有序列表长句自动折行时悬挂缩进对齐效果的测试文本，确保第二行起点对齐正文首字而不是顶在序号正下方。'.repeat(3)
    await setDoc(longOrdered)
    await setCursor(longOrdered.length)
    await sleep(160)
    const hangGeom = JSON.parse(await evaluate(renderer, `(() => {
      const line = document.querySelector('#editor .cm-md-li-ordered')
      const mark = line && line.querySelector('.cm-md-listmark')
      if (!line || !mark) return 'null'
      const markRect = mark.getBoundingClientRect()
      const range = document.createRange()
      // 找正文第一个字符和足够靠后必在第二行的字符坐标
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      let bodyNode = null
      while (walker.nextNode()) {
        if (walker.currentNode.nodeValue && walker.currentNode.nodeValue.includes('这是一段')) {
          bodyNode = walker.currentNode
          break
        }
      }
      if (!bodyNode) return 'null'
      const idx = bodyNode.nodeValue.indexOf('这是一段')
      range.setStart(bodyNode, idx)
      range.setEnd(bodyNode, idx + 1)
      const firstBodyRect = range.getBoundingClientRect()
      // 找第一个 top 明显大于首行的字符（第二行首字）
      let secondLineRect = null
      for (let i = idx + 1; i < bodyNode.nodeValue.length; i++) {
        range.setStart(bodyNode, i)
        range.setEnd(bodyNode, i + 1)
        const r = range.getBoundingClientRect()
        if (r.top > firstBodyRect.top + 8) {
          secondLineRect = r
          break
        }
      }
      return JSON.stringify({
        markLeft: Math.round(markRect.left),
        firstBodyLeft: Math.round(firstBodyRect.left),
        secondLineLeft: secondLineRect ? Math.round(secondLineRect.left) : null,
      })
    })()`))
    check('有序列表长句折行悬挂缩进对齐正文首字而非顶在序号下',
      hangGeom && hangGeom.secondLineLeft !== null &&
      hangGeom.secondLineLeft > hangGeom.markLeft + 8 &&
      Math.abs(hangGeom.secondLineLeft - hangGeom.firstBodyLeft) <= 8,
      JSON.stringify(hangGeom))

    // 6. 退出列表/删空项后停在空行（即便下方隔空行还有另一张列表），光标 X 坐标立刻与普通段落左对齐，打字不跳
    await setDoc('新增付费用户\n\n1. 测试\n2. 测试\n3. \n\n8. 甲')
    await setCursor(22) // 停在 `3. ` 末尾
    await press(renderer, 'Enter') // 退出列表，留空行在 `2. 测试` 下方
    const emptyLineGeom = JSON.parse(await evaluate(renderer, `(() => {
      const v = ${VIEW}
      const paraLeft = v.coordsAtPos(0)?.left ?? null
      const caretPos = v.state.selection.main.head
      const caretLeft = v.coordsAtPos(caretPos)?.left ?? null
      const lineIdx = v.state.doc.lineAt(caretPos).number - 1
      const lineCls = [...document.querySelectorAll('#editor .cm-line')][lineIdx]?.className ?? ''
      return JSON.stringify({ paraLeft, caretLeft, lineCls })
    })()`))
    check('退出列表后空行不残留列表缩进且光标立刻对齐正文左缘',
      emptyLineGeom.paraLeft !== null &&
      emptyLineGeom.caretLeft !== null &&
      (!emptyLineGeom.lineCls.includes('cm-md-li') || emptyLineGeom.lineCls.includes('cm-md-li-blank')) &&
      Math.abs(emptyLineGeom.caretLeft - emptyLineGeom.paraLeft) <= 1,
      JSON.stringify(emptyLineGeom))

    // 7. 列表项内嵌围栏代码块：在父项后新增同级项时，代码块内编号纹丝不动，外层后续项正常递增
    await setDoc('1. 父项\n    ```\n    8. 代码内A\n    10. 代码内B\n    ```\n2. 下一项')
    await setCursor(5) // `1. 父项` 行尾
    await press(renderer, 'Enter')
    await renderer.send('Input.insertText', { text: '插入项' })
    await sleep(80)
    check('列表内嵌围栏代码块编号不被重排器篡改且外层正常递增',
      (await docOf()) === '1. 父项\n2. 插入项\n    ```\n    8. 代码内A\n    10. 代码内B\n    ```\n3. 下一项',
      JSON.stringify(await docOf()))

    // 8. 双 Tab 缩进孙项按 Shift+Tab 只退一级（从 8 列退到 4 列，不一口吞光两个 Tab）
    await setDoc('1. 父\n\t1. 子\n\t\t1. 孙')
    await setCursor(16) // 停在 `\t\t1. 孙` 正文
    await press(renderer, 'Tab', 8)
    check('双 Tab 缩进孙项按 Shift+Tab 只退一级不吞光缩进',
      (await docOf()) === '1. 父\n\t1. 子\n\t2. 孙',
      JSON.stringify(await docOf()))

    // 9. 多行选区首行是普通段落、次行是列表首项，按 Tab 不把列表首项推成代码块
    await setDoc('说明\n1. 首项\n2. 次项')
    await evaluate(renderer, `${VIEW}.dispatch({ selection: { anchor: 0, head: 10 } })`)
    await sleep(60)
    await press(renderer, 'Tab')
    check('跨段落与列表首项的多行选区按 Tab 不把首项推进代码块',
      (await docOf()) === '说明\n1. 首项\n2. 次项',
      JSON.stringify(await docOf()))

    // 10. 跨行行内代码里的 `2. ` 不被 Paragraph 兜底误渲染成列表缩进（1. 按 CommonMark 本来会打断段落，2. 留在 InlineCode 内）
    await setDoc('`前文\n2. 代码里的编号`')
    await setCursor(0)
    const inlineCodeLineCls = await evaluate(renderer, `(() => {
      const lines = [...document.querySelectorAll('#editor .cm-line')]
      return lines[1]?.className ?? ''
    })()`)
    check('跨行行内代码中的 `2. ` 不误渲染为列表格式',
      !inlineCodeLineCls.includes('cm-md-li'),
      JSON.stringify(inlineCodeLineCls))

    // 11. 双 Tab 空孙项按 Enter / Shift+Tab 退一级不抛 RangeError 且正确留在 1 个 Tab
    await setDoc('1. 甲\n\t1. 乙\n\t\t1. ')
    await setCursor(16)
    await press(renderer, 'Enter')
    check('双 Tab 空孙项按 Enter 退一级不崩溃且只退一个 Tab',
      (await docOf()) === '1. 甲\n\t1. 乙\n\t2. ',
      JSON.stringify(await docOf()))

    // 12. 普通行粘贴围栏代码块时，代码块内乱序编号不被重排器篡改
    await setDoc('说明\n')
    await setCursor(3)
    await evaluate(renderer, `${VIEW}.dispatch({ changes: { from: 3, to: 3, insert: '\`\`\`\\n2. a\\n5. b\\n\`\`\`' }, userEvent: 'input.paste' })`)
    await sleep(80)
    check('粘贴围栏代码块时代码块内编号不被重排器篡改',
      (await docOf()) === '说明\n```\n2. a\n5. b\n```',
      JSON.stringify(await docOf()))

    // 13. 围栏代码块闭合行之后紧接粘贴/新建有序列表，正常参与重排
    await setDoc('```\ncode\n```')
    await setCursor(12)
    await evaluate(renderer, `${VIEW}.dispatch({ changes: { from: 12, to: 12, insert: '\\n1. 甲\\n5. 乙' }, userEvent: 'input.paste' })`)
    await sleep(80)
    check('围栏代码块闭合后新建有序列表正常重排',
      (await docOf()) === '```\ncode\n```\n1. 甲\n2. 乙',
      JSON.stringify(await docOf()))

    // 14. 选中首项整行替换为普通段落，下方 `2. 乙\n3. 丙` 自动归 `1. / 2.`
    await setDoc('1. 甲\n2. 乙\n3. 丙')
    await evaluate(renderer, `${VIEW}.dispatch({ changes: { from: 0, to: 5, insert: '测试\\n' }, userEvent: 'input.paste' })`)
    await sleep(80)
    check('首项整行被替换为普通文字后下方自动归 1./2.',
      (await docOf()) === '测试\n1. 乙\n2. 丙',
      JSON.stringify(await docOf()))

    // 15. 删掉带子列表的父项首行后，4 空格孤立子项不和下方 0 空格项串组
    await setDoc('1. 父\n    1. 子1\n    2. 子2\n2. 乙')
    await setCursor(3)
    await press(renderer, 'Backspace')
    check('取消带子列表父项格式后孤立子项不和下方顶格项串组且下方归 1.',
      (await docOf()) === '父\n    1. 子1\n    2. 子2\n1. 乙',
      JSON.stringify(await docOf()))

    // 16. 围栏代码块内的 `- [ ] code` 按退格不整段删掉 `[ ] `
    await setDoc('```\n- [ ] code\n```')
    await setCursor(10) // `code` 之前
    await press(renderer, 'Backspace')
    check('围栏代码块内任务文本前退格只删一个空格不拆框',
      (await docOf()) === '```\n- [ ]code\n```',
      JSON.stringify(await docOf()))

    // 17. 普通折行段落里的 `2026. 敬请期待。` 不被误画成列表，且可以正常定位到数字里编辑
    await setDoc('发布会定在\n2026. 敬请期待。')
    await setCursor(0)
    const wrappedYearState = JSON.parse(await evaluate(renderer, `(() => {
      const lines = [...document.querySelectorAll('#editor .cm-line')]
      return JSON.stringify({ cls: lines[1]?.className ?? '' })
    })()`))
    await evaluate(renderer, `${VIEW}.dispatch({ selection: { anchor: 8 }, userEvent: 'select.pointer' })`)
    await sleep(60)
    const yearCaret = await headOf()
    check('普通折行段落里的 2026. 不误变列表也不锁定光标',
      !wrappedYearState.cls.includes('cm-md-li') && yearCaret === 8,
      `cls=${JSON.stringify(wrappedYearState.cls)} caret=${yearCaret}`)

    // 18. 引用后紧跟 Tab（`>\\t1. foo`）不触发重叠装饰崩溃且正常渲染
    await setDoc('>\t1. 引用制表符项')
    await setCursor(4)
    const quoteTabCls = await evaluate(renderer, `[...document.querySelectorAll('#editor .cm-line')][0]?.className ?? ''`)
    check('引用后紧跟 Tab 的有序列表正常渲染无装饰冲突',
      quoteTabCls.includes('cm-md-blockquote') && quoteTabCls.includes('cm-md-li'),
      JSON.stringify(quoteTabCls))

    // 19. 敲 `1.` 后按 Tab 不触发有序列表格式，回车不续 `2.`
    await setDoc('1.')
    await setCursor(2)
    await press(renderer, 'Tab')
    const orderedTabState = JSON.parse(await evaluate(renderer, `(() => {
      const line = document.querySelector('#editor .cm-line')
      return JSON.stringify({
        cls: line?.className ?? '',
        hasMark: !!line?.querySelector('.cm-md-listmark'),
      })
    })()`))
    await press(renderer, 'Enter')
    check('敲 1. 后按 Tab 不触发有序列表格式也不续 2.',
      !orderedTabState.cls.includes('cm-md-li')
        && !orderedTabState.hasMark
        && (await docOf()) === '1.\t\n\n',
      `state=${JSON.stringify(orderedTabState)} doc=${JSON.stringify(await docOf())}`)

    // 20. 敲 `-` 后按 Tab 不触发无序列表格式也不出现圆点，回车不续 `- `
    // 段落排版下「说明」回车是新的一段，所以起点是两段：说明、-
    await setDoc('说明\n\n-')
    await setCursor(5)
    await press(renderer, 'Tab')
    await setCursor(0) // 移开光标验证非激活行也不把 `-` 画成圆点
    const bulletTabState = JSON.parse(await evaluate(renderer, `(() => {
      const lines = [...document.querySelectorAll('#editor .cm-line')]
      const line = lines.find((l) => l.textContent.startsWith('-'))
      return JSON.stringify({
        cls: line?.className ?? '',
        hasBullet: !!line?.querySelector('.cm-md-bullet'),
      })
    })()`))
    await setCursor(6)
    await press(renderer, 'Enter')
    // `-\t` 不是列表，回车按正文新起一段（段落排版：一次回车插入两个换行），不续 `- `。
    check('敲 - 后按 Tab 不触发无序列表格式也不出圆点',
      !bulletTabState.cls.includes('cm-md-li')
        && !bulletTabState.hasBullet
        && (await docOf()) === '说明\n\n-\t\n\n',
      `state=${JSON.stringify(bulletTabState)} doc=${JSON.stringify(await docOf())}`)

    // 21. 引用行 `> 1.` 后按 Tab 插入制表符而非空格，不触发列表格式且回车只续 `> `
    await setDoc('> 1.')
    await setCursor(4)
    await press(renderer, 'Tab')
    const quoteAfterNumCls = await evaluate(renderer, `[...document.querySelectorAll('#editor .cm-line')][0]?.className ?? ''`)
    await press(renderer, 'Enter')
    check('引用内 1. 后按 Tab 不触发列表格式且回车只续引用',
      (await docOf()) === '> 1.\t\n> ' && !quoteAfterNumCls.includes('cm-md-li'),
      `doc=${JSON.stringify(await docOf())} cls=${JSON.stringify(quoteAfterNumCls)}`)

    // 22. 双击隔空行后有序列表的 `1.` 选中数字，改回 `2` 后同组顺延为 `2. 乙 / 3. 丙`
    await setDoc('1. 甲\n\n插一段\n\n1. 乙\n2. 丙')
    await setCursor(0)
    await sleep(140)
    const secondListMarkPos = JSON.parse(await evaluate(renderer, `(() => {
      const marks = [...document.querySelectorAll('#editor .cm-md-li-ordered .cm-md-listmark')]
      const m = marks[1]
      if (!m) return 'null'
      const r = m.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`))
    if (secondListMarkPos) {
      for (const clickCount of [1, 2]) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await renderer.send('Input.dispatchMouseEvent', {
            type, x: secondListMarkPos.x, y: secondListMarkPos.y, button: 'left', clickCount,
          })
        }
      }
      await sleep(160)
    }
    const dblSel = JSON.parse(await evaluate(renderer, `(() => {
      const r = ${VIEW}.state.selection.main
      return JSON.stringify({ from: r.from, to: r.to, text: ${VIEW}.state.sliceDoc(r.from, r.to) })
    })()`))
    await renderer.send('Input.insertText', { text: '2' })
    await sleep(160)
    check('双击有序序号选中纯数字并改起始号，同组顺延',
      dblSel.text === '1' && (await docOf()) === '1. 甲\n\n插一段\n\n2. 乙\n3. 丙',
      `dblSel=${JSON.stringify(dblSel)} doc=${JSON.stringify(await docOf())}`)

    // 23. 有序列表中间插入普通行：行首 Tab 按上一项正文宽度对齐、接回下方序号，且渲染层不再叠双倍缩进
    const contDoc = '1. 甲\n新内容\n1. 乙\n2. 丙'
    await setDoc(contDoc)
    await setCursor(contDoc.indexOf('新内容'))
    await press(renderer, 'Tab')
    await sleep(140)
    const afterContTab = await docOf()
    const contGeom = JSON.parse(await evaluate(renderer, `(() => {
      const lines = [...document.querySelectorAll('#editor .cm-line')]
      const firstLine = lines[0]
      const contLine = lines[1]
      const findCharLeft = (el, ch) => {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        while (w.nextNode()) {
          const i = w.currentNode.nodeValue.indexOf(ch)
          if (i >= 0) {
            const r = document.createRange()
            r.setStart(w.currentNode, i)
            r.setEnd(w.currentNode, i + 1)
            return r.getBoundingClientRect().left
          }
        }
        return null
      }
      return JSON.stringify({
        cls: contLine?.className ?? '',
        text: contLine?.textContent ?? '',
        firstLeft: firstLine ? findCharLeft(firstLine, '甲') : null,
        contLeft: contLine ? findCharLeft(contLine, '新') : null,
      })
    })()`))
    check('列表中间插入普通行按 Tab 对齐正文、接回编号且无双倍缩进',
      afterContTab === '1. 甲\n   新内容\n2. 乙\n3. 丙'
        && contGeom.cls.includes('cm-md-li-ordered-cont')
        && contGeom.text === '新内容'
        && contGeom.firstLeft !== null && contGeom.contLeft !== null
        && Math.abs(contGeom.contLeft - contGeom.firstLeft) <= 8,
      `doc=${JSON.stringify(afterContTab)} geom=${JSON.stringify(contGeom)}`)

    // 24. 列表续行按 Shift+Tab 或行首退格一次退回顶格（不卡 2 空格）
    await press(renderer, 'Tab', 8) // Shift+Tab
    const afterContShiftTab = await docOf()
    await press(renderer, 'Tab')
    await press(renderer, 'Backspace')
    const afterContBackspace = await docOf()
    check('列表续行按 Shift+Tab 与行首退格均一次干净退回顶格',
      afterContShiftTab === '1. 甲\n新内容\n1. 乙\n2. 丙'
        && afterContBackspace === '1. 甲\n新内容\n1. 乙\n2. 丙',
      `shiftTab=${JSON.stringify(afterContShiftTab)} backspace=${JSON.stringify(afterContBackspace)}`)

    // 25. 嵌套子列表中间插普通行：Tab 逐级对齐并接回子项与外层编号，Shift+Tab 逐级退回顶格
    const nestedContDoc = '1. 甲\n    1. 子一\n新内容\n    1. 子二\n1. 乙'
    await setDoc(nestedContDoc)
    await setCursor(nestedContDoc.indexOf('新内容'))
    await press(renderer, 'Tab')
    const nestedTab1 = await docOf()
    await press(renderer, 'Tab')
    const nestedTab2 = await docOf()
    await press(renderer, 'Tab', 8)
    const nestedShift1 = await docOf()
    await press(renderer, 'Tab', 8)
    const nestedShift2 = await docOf()
    check('嵌套列表中间普通行 Tab/Shift+Tab 逐级对齐并恢复编号',
      nestedTab1 === '1. 甲\n    1. 子一\n   新内容\n    2. 子二\n2. 乙'
        && nestedTab2 === '1. 甲\n    1. 子一\n       新内容\n    2. 子二\n2. 乙'
        && nestedShift1 === '1. 甲\n    1. 子一\n   新内容\n    2. 子二\n2. 乙'
        && nestedShift2 === '1. 甲\n    1. 子一\n新内容\n    1. 子二\n1. 乙',
      JSON.stringify({ nestedTab1, nestedTab2, nestedShift1, nestedShift2 }))

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
