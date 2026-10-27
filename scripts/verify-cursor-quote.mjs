// 导航用真实 CDP 按键；oracle 用浏览器文字 Range，与 CM 高度表独立。
import { readFileSync, writeFileSync } from 'node:fs'

export async function verifyCursorQuote({ evaluate, send, key, setDoc, type, check, mainEval, ELECTRON }) {
  const records = [], failures = []
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const record = (name, ok, detail) => { const r = { name, ok, ...detail }; records.push(r); if (!ok) failures.push(r) }
  const quote = '> | 名称 | 数量 | 备注 |\n> | --- | ---: | --- |\n> | 引用甲 | 2 | 可编辑 |\n> | 引用乙 |  | 空格 |\n>\n> 引用内的后续段落。\n\n试末格。'
  const click = async (text, offset = 0, lineHint = null) => {
    const position = await evaluate(`(() => {const p=${lineHint===null?'v.state.doc.toString().indexOf('+JSON.stringify(text)+')':'v.state.doc.line('+lineHint+').from'};v.requestMeasure();v.scrollDOM.scrollTop=Math.max(0,v.lineBlockAt(p).top-150);v.requestMeasure();v.coordsAtPos(p);return p})()`)
    await wait(120)
    // 高度表若已漂移，先按实际 DOM 滚到目标，不能拿错误估计当点击坐标。
    for(let i=0;i<30;i++) {
      const found = await evaluate(`(() => {const w=document.createTreeWalker(v.contentDOM,NodeFilter.SHOW_TEXT);for(let n;n=w.nextNode();)if(n.textContent.includes(${JSON.stringify(text)})&&(${lineHint===null?'true':'v.state.doc.lineAt(v.posAtDOM(n,0)).number==='+lineHint})){n.parentElement.scrollIntoView({block:'center'});return n.parentElement.getBoundingClientRect().height>0}return false})()`)
      await wait(80)
      if(found)break
      await evaluate(`v.requestMeasure();v.scrollDOM.scrollTop=Math.max(0,v.lineBlockAt(${position}).top-150);v.requestMeasure();v.coordsAtPos(${position})`)
    }
    const box = await evaluate(`(() => {const w=document.createTreeWalker(v.contentDOM,NodeFilter.SHOW_TEXT);for(let n;n=w.nextNode();){const i=n.textContent.indexOf(${JSON.stringify(text)});if(i<0||!(${lineHint===null?'true':'v.state.doc.lineAt(v.posAtDOM(n,0)).number==='+lineHint}))continue;const r=document.createRange();r.setStart(n,i+${offset});r.setEnd(n,i+${offset}+1);const b=r.getBoundingClientRect();if(b.width&&b.height)return {x:b.left+1,y:(b.top+b.bottom)/2,expected:v.posAtDOM(n,i+${offset})}}throw Error('未找到点击文字 '+JSON.stringify({text:${JSON.stringify(text)},scroll:v.scrollDOM.scrollTop,viewport:v.viewport}))})()`)
    const before=await evaluate(`v.posAtCoords({x:${box.x},y:${box.y}})`)
    for(const t of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type:t,x:box.x,y:box.y,button:'left',clickCount:1})
    await wait(60)
    const actual=await evaluate('v.state.selection.main.head')
    record('点击 '+text,actual===box.expected&&before===box.expected,{actual,posAtCoords:before,expected:box.expected})
  }
  const state = () => evaluate(`(() => {const p=v.state.selection.main.head,l=v.state.doc.lineAt(p);return {head:p,line:l.number,column:p-l.from,text:l.text}})()`)
  // 固定目标行的 DOM oracle：每步独立计算源列，不用产品 moveVertically / posAtCoords。
  const oracle = (line, x, column = 0) => evaluate(`(() => {
    const line=v.state.doc.line(${line}),el=[...v.contentDOM.querySelectorAll('.cm-line')].find(n=>v.state.doc.lineAt(v.posAtDOM(n,0)).number===line.number);
    if(!el)return {line:line.number,column:null};const b=el.getBoundingClientRect(),y=(b.top+b.bottom)/2;
    const c=document.caretPositionFromPoint(${x},y);let p=c&&v.contentDOM.contains(c.offsetNode)?v.posAtDOM(c.offsetNode,c.offset):line.to;
    const cell=el.querySelector('.cm-md-table-cell[data-column="${column}"]');
    let from=line.from+/^[ \\t>]*(?:(?:[-*+]|\\d+[.)]|#{1,6})[ \\t]+)?/.exec(line.text)[0].length,to=line.to;
    if(cell){const pipes=[...line.text].flatMap((c,i)=>c==='|'?[i]:[]);from=line.from+pipes[${column}]+1;to=line.from+pipes[${column+1}];while(/\\s/.test(v.state.sliceDoc(from,from+1))&&from<to)from++;while(/\\s/.test(v.state.sliceDoc(to-1,to))&&to>from)to--}
    p=Math.max(from,Math.min(to,p));return {line:line.number,column:p-line.from};
  })()`)
  const walk = async (label, lines, title = '名称', column = 0) => {
    await click(title, 0, lines[0])
    const x=await evaluate('v.coordsAtPos(v.state.selection.main.head).left')
    let index=0
    const step = async (direction,n) => {
      index+=direction
      const expected=await oracle(lines[index],x,column)
      await key(direction>0?'ArrowDown':'ArrowUp')
      const actual=await state()
      record(label+' '+n,actual.line===expected.line&&actual.column===expected.column,{expected,actual})
    }
    for(let i=1;i<lines.length;i++)await step(1,'↓'+i)
    for(let i=1;i<lines.length;i++)await step(-1,'↑'+i)
    let seed=0x436f6c61
    for(let i=0;i<60;i++){
      seed=(Math.imul(seed,1664525)+1013904223)>>>0
      const direction=index===0?1:index===lines.length-1?-1:(seed>>>16)&1?1:-1
      await step(direction,'往返'+i)
    }
  }
  try {
    for(const [label,doc,lines] of [
      ['引用表格',quote,[1,3,4,6,8]],
      ['列表边界','- 列表起点\n\n'+quote+'\n\n- 列表终点',process.env.CURSOR_QUOTE_WITH_PARAGRAPH ? [3,5,6,8,10,12] : [3,5,6,8,10,11,12]],
    ]){
      await setDoc(doc)
      for(const change of ['初始','格内输入','引用Enter','撤销','滚动','缩窗']){
        if(change==='格内输入'){await click('引用甲');await type('X')}
        if(change==='引用Enter'){await click('引用内的后续段落');await key('ArrowRight',process.platform==='darwin'?4:2);await key('Enter');await wait(80);const s=await state();record('回车补引用源码',/^\s*>/.test(s.text),s);record('回车立即引用样式',await evaluate(`(()=>{const n=v.domAtPos(v.state.selection.main.head).node;return !!(n.nodeType===1?n:n.parentElement).closest('.cm-md-blockquote')})()`),s);await key('z',process.platform==='darwin'?4:2)}
        if(change==='撤销')await key('z',process.platform==='darwin'?4:2)
        if(change==='滚动'){await evaluate('v.scrollDOM.scrollTop=10000');await wait(80);await evaluate('v.scrollDOM.scrollTop=0');await wait(80)}
        if(change==='缩窗'){await mainEval(`${ELECTRON}.BrowserWindow.getAllWindows()[0].setContentSize(650,800)`);await wait(180)}
        await walk(label+'/'+change,lines)
      }
      await mainEval(`${ELECTRON}.BrowserWindow.getAllWindows()[0].setContentSize(1200,900)`)
    }
    await setDoc(quote)
    await walk('引用表格/第二列',[1,3,4,6,8],'数量',1)
    await walk('引用表格/第三列',[1,3,4,6,8],'备注',2)
    for (const [label, source, lines, title] of [
      ['普通表格双侧', '前段。\n\n| 名称 | 数量 |\n|---|---|\n| 苹果 | 2 |\n\n后段。', [3,5,7], '名称'],
      ['两条表格分隔', '前段。\n\n\n| 名称 | 数量 |\n|---|---|\n| 苹果 | 2 |\n\n\n后段。', [4,6,9], '名称'],
      ['无表格引用', '> 引用甲。\n>\n> 引用乙。\n\n外段。', [1,3,5], '引用甲'],
      ['引用代码空行保留', '> ```\n> 引用甲。\n>\n> 引用乙。\n> ```', [2,3,4], '引用甲'],
    ]) {
      await setDoc(source)
      await walk(label, lines, title)
    }
    // 从虚拟视口中部进入多表长文，覆盖分隔行成为 wrapper 首个可见子行的情况。
    const prefix=Array.from({length:24},(_,i)=>`段落${i}\n\n| H | V |\n|---|---|\n| 前表${i} | value |\n\n`).join('')
    await setDoc(prefix+quote+'\n\n'+Array.from({length:60},(_,i)=>`尾段${i}`).join('\n\n'))
    for(let cycle=0;cycle<4;cycle++){
      await click('试末格');await click('引用内的后续段落');await click('引用甲');await type('编辑');await key('Backspace');
      await evaluate('v.scrollDOM.scrollTop+=700');await wait(100)
      await click('试末格')
      const errors=await evaluate(`(()=>{const rows=[...v.contentDOM.querySelectorAll('.cm-line')].filter(n=>n.getBoundingClientRect().height>0);return rows.map(n=>{const p=v.posAtDOM(n,0),b=n.getBoundingClientRect(),block=v.lineBlockAt(p),h=Array.isArray(block.type)?block.type.find(part=>part.type===0&&part.from<=p&&part.to>=p)??block:block;return {line:v.state.doc.lineAt(p).number,delta:b.top-(v.documentTop+h.top)}}).filter(r=>Math.abs(r.delta)>8)})()`)
      record('长文高度表 '+cycle,errors.length===0,{errors})
    }
    if(process.env.CURSOR_QUOTE_MANUAL_FIXTURE) {
      const manual=readFileSync(process.env.CURSOR_QUOTE_MANUAL_FIXTURE,'utf8')
      await setDoc(manual)
      await mainEval(`${ELECTRON}.BrowserWindow.getAllWindows()[0].setContentSize(1200,900)`)
      for(const [section,title,offsets] of [
        ['21','名称',[0,2,3,5,7]],
        ['22','名称',[0,2,3,5]],
        ['23','名称',[0,2,3,5]],
        ['24','项目',[0,2,3]],
      ]) {
        const start=await evaluate(`(()=>{const s=v.state.doc.toString(),at=s.indexOf('## ${section} '),p=s.indexOf('| ${title}',at);return v.state.doc.lineAt(p).number})()`)
        await walk('原始手动文档第'+section+'节',offsets.map(n=>n+start),title)
      }
    }
    await setDoc('> 引用第一行。')
    await click('引用第一行');await key('ArrowUp');await wait(80)
    record('文首引用临时落点',await evaluate(`!!v.contentDOM.querySelector('.cm-md-table-paragraph-input')`),await state())
    await key('ArrowUp');record('继续向上移除临时落点',!await evaluate(`!!v.contentDOM.querySelector('.cm-md-table-paragraph-input')`),await state())
    record('文首浏览不写字节',await evaluate(`v.state.doc.toString()==='> 引用第一行。'`),await state())
    await click('引用第一行');await key('ArrowUp');await type('引用外正文');record('临时落点实际输入才写段落',await evaluate(`v.state.doc.toString()==='引用外正文\\n\\n> 引用第一行。'`),await state())
    await key('z',process.platform==='darwin'?4:2);record('临时段落输入一步撤销',await evaluate(`v.state.doc.toString()==='> 引用第一行。'`),await state())
  } finally {
    if(process.env.CURSOR_QUOTE_REPORT)writeFileSync(process.env.CURSOR_QUOTE_REPORT,JSON.stringify({records,failures},null,2))
    console.log(`CURSOR_QUOTE ${records.length} 条，失败 ${failures.length}`)
  }
  check('引用表格真实双向导航、60步往返及状态变化',!failures.length,JSON.stringify(failures.slice(0,12)))
}
