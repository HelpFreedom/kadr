// Annotation task tracks: real UI creation/edit/drag/status/list plus MCP
// list/start/complete, concurrent timing preservation, one-step undo, and
// deleted-task conflict behavior. Run the app with CDP enabled first.
import WebSocket from 'ws'
import { spawn } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'

const PORT = Number(process.env.KADR_CDP_PORT || 9777)
const USER_DATA = process.env.KADR_USER_DATA
if (!USER_DATA) throw new Error('KADR_USER_DATA must point at the isolated e2e profile')
mkdirSync(USER_DATA, { recursive: true })
writeFileSync(`${USER_DATA}/claude-env.json`, JSON.stringify({ command: 'bash', args: [] }))

async function getPageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = pages.find((item) => item.type === 'page' && item.url.includes('localhost'))
      if (page) return page.webSocketDebuggerUrl
    } catch { /* app starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('CDP target not found')
}

let sequence = 0
let ws
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const onMessage = (raw) => {
      const message = JSON.parse(raw)
      if (message.id !== id) return
      ws.off('message', onMessage)
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function rawEval(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  }
  return result.result.value
}
async function evalJs(expression, timeout = 30000) {
  const key = `annotation_${Date.now()}_${++sequence}`
  await rawEval(
    `window.__e2e = window.__e2e || {};` +
    `(async()=>{try{window.__e2e.${key}=JSON.stringify({ok:await(${expression})})}` +
    `catch(e){window.__e2e.${key}=JSON.stringify({err:String(e?.message||e)})}})();0`
  )
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await rawEval(`window.__e2e.${key} ?? null`)
    if (value !== null) {
      const parsed = JSON.parse(value)
      if (parsed.err) throw new Error(parsed.err)
      return parsed.ok
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('evaluation timeout')
}
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!condition) process.exitCode = 1
}

ws = new WebSocket(await getPageWs())
await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })

await evalJs(`(async()=>{
  const ed=window.kadrEditor
  const blank={version:1,id:ed.uid(),name:'Annotation E2E',width:1920,height:1080,fps:30,
    background:'#000000',tracks:[
      {id:ed.uid(),kind:'video',name:'V1',muted:false,locked:false,gain:1,clips:[]},
      {id:ed.uid(),kind:'audio',name:'A1',muted:false,locked:false,gain:1,clips:[]}
    ],assets:[]}
  ed.useEditor.getState().setProject(blank)
  ed.useEditor.getState().setPlayhead(5)
  return true
})()`)

// A+ through the visible transport, then type into the focused card.
const created = await evalJs(`(async()=>{
  const button=[...document.querySelectorAll('.transport button')].find((el)=>el.textContent.trim()==='A+')
  button?.click()
  for(let i=0;i<30&&!document.querySelector('.annotation-dialog textarea');i++)
    await new Promise(requestAnimationFrame)
  const textarea=document.querySelector('.annotation-dialog textarea')
  const focused=document.activeElement===textarea
  const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set
  setter.call(textarea,'Убрать паузу и выровнять звук')
  textarea.dispatchEvent(new Event('input',{bubbles:true}))
  await new Promise(requestAnimationFrame)
  document.querySelector('.annotation-dialog .primary').click()
  await new Promise(requestAnimationFrame)
  const st=window.kadrEditor.useEditor.getState()
  const track=st.project.tracks.find((item)=>item.kind==='annotation')
  const task=track.annotations[0]
  return {focused,trackName:track.name,id:task.id,text:task.text,start:task.start,duration:task.duration,
    block:!!document.querySelector('[data-annotation-id="'+task.id+'"]')}
})()`)
check('A+ creates an annotation track and focused four-second task card',
  created.focused && created.text.includes('паузу') && created.start === 5 && created.duration === 4 && created.block,
  JSON.stringify(created))
check('task receives a stable random id', created.id.length >= 8, created.id)

// Timeline drag by two seconds, then resize the right edge by one second.
const timing = await evalJs(`(async()=>{
  const id=${JSON.stringify(created.id)}
  const drag=(target,dx)=>new Promise((resolve)=>{
    const r=target.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2
    const opts={bubbles:true,pointerId:17,isPrimary:true,button:0,clientX:x,clientY:y}
    target.dispatchEvent(new PointerEvent('pointerdown',opts))
    window.dispatchEvent(new PointerEvent('pointermove',{...opts,clientX:x+dx}))
    window.dispatchEvent(new PointerEvent('pointerup',{...opts,clientX:x+dx}))
    requestAnimationFrame(()=>requestAnimationFrame(resolve))
  })
  let task=()=>window.kadrEditor.getAnnotationTasks().find((item)=>item.id===id)
  let block=document.querySelector('[data-annotation-id="'+id+'"]')
  await drag(block,2*window.kadrEditor.useEditor.getState().zoom)
  block=document.querySelector('[data-annotation-id="'+id+'"]')
  await drag(block.querySelector('.annotation-resize.right'),window.kadrEditor.useEditor.getState().zoom)
  return {start:task().start,duration:task().duration}
})()`)
check('timeline drag moves and resizes the task',
  Math.abs(timing.start - 7) < 0.05 && Math.abs(timing.duration - 5) < 0.05,
  JSON.stringify(timing))

// Tab/list navigation and a user status change through the card.
const panel = await evalJs(`(async()=>{
  const tab=[...document.querySelectorAll('.side-tabs button')]
    .find((el)=>/Аннотации|Annotations/.test(el.textContent))
  tab.click(); await new Promise(requestAnimationFrame)
  const item=document.querySelector('[data-annotation-list-id="${created.id}"]')
  item.click(); await new Promise(requestAnimationFrame)
  const status=document.querySelector('.annotation-dialog .annotation-statuses .status-in_progress')
  status.click(); await new Promise(requestAnimationFrame)
  const live=window.kadrEditor.getAnnotationTasks().find((task)=>task.id==='${created.id}')
  const block=document.querySelector('[data-annotation-id="${created.id}"]')
  document.querySelector('.annotation-dialog-head button').click()
  return {list:!!item,status:live.status,blue:block.classList.contains('status-in_progress')}
})()`)
check('Annotations tab navigates to a task and status color updates',
  panel.list && panel.status === 'in_progress' && panel.blue, JSON.stringify(panel))

// Create a fresh MCP task via A+ so its original status is new.
const mcpTask = await evalJs(`(async()=>{
  const st=window.kadrEditor.useEditor.getState(); st.setPlayhead(20)
  await new Promise(requestAnimationFrame)
  await new Promise(requestAnimationFrame)
  ;[...document.querySelectorAll('.transport button')].find((el)=>el.textContent.trim()==='A+').click()
  await new Promise(requestAnimationFrame)
  const textarea=document.querySelector('.annotation-dialog textarea')
  const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set
  setter.call(textarea,'Сделать фон тестовым через MCP')
  textarea.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(requestAnimationFrame)
  document.querySelector('.annotation-dialog .primary').click(); await new Promise(requestAnimationFrame)
  return window.kadrEditor.getAnnotationTasks().find((task)=>task.text.startsWith('Сделать фон'))
})()`)

const bridge = await evalJs(`(async()=>window.kadr.claudeOpen(80,24,null))()`)
const mcp = spawn('node', ['electron/mcp-bridge.cjs', String(bridge.port)], {
  cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit']
})
let buffer = ''
let requestId = 0
const pending = new Map()
mcp.stdout.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.id != null && pending.has(message.id)) {
      pending.get(message.id)(message); pending.delete(message.id)
    }
  }
})
const mcpCall = (method, params) => new Promise((resolve, reject) => {
  const id = ++requestId
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)) }, 30000)
  pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
await mcpCall('initialize', {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'annotation-e2e', version: '1' }
})
mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
const tools = await mcpCall('tools/list', {})
const toolNames = (tools.result?.tools ?? []).map((tool) => tool.name)
check('MCP exposes annotation task tools',
  ['kadr_tasks','kadr_task_start','kadr_task_complete'].every((name)=>toolNames.includes(name)),
  toolNames.filter((name)=>name.includes('task')).join(','))

const listed = await mcpCall('tools/call', { name: 'kadr_tasks', arguments: { status: 'new' } })
const newTasks = JSON.parse(listed.result.content[0].text)
check('MCP lists live tasks with stable ids and timing',
  newTasks.some((task)=>task.id===mcpTask.id && task.start===20 && task.end===24))

await mcpCall('tools/call', { name: 'kadr_task_start', arguments: { id: mcpTask.id } })

// Simulate the user's concurrent timeline drag after the agent has read/started the task.
const concurrent = await evalJs(`(async()=>{
  const id='${mcpTask.id}', block=document.querySelector('[data-annotation-id="'+id+'"]')
  const r=block.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2
  const dx=2*window.kadrEditor.useEditor.getState().zoom
  const opts={bubbles:true,pointerId:23,isPrimary:true,button:0,clientX:x,clientY:y}
  block.dispatchEvent(new PointerEvent('pointerdown',opts))
  window.dispatchEvent(new PointerEvent('pointermove',{...opts,clientX:x+dx}))
  window.dispatchEvent(new PointerEvent('pointerup',{...opts,clientX:x+dx}))
  await new Promise(requestAnimationFrame)
  return window.kadrEditor.getAnnotationTasks().find((task)=>task.id===id).start
})()`)

const completed = await mcpCall('tools/call', {
  name: 'kadr_task_complete',
  arguments: {
    id: mcpTask.id,
    result: 'Фон проекта обновлён тестовым агентом',
    code: `const st=window.kadrEditor.useEditor.getState();\n` +
      `st.pushHistory('hEdit');\n` +
      `window.kadrEditor.useEditor.setState({project:{...st.project,background:'#123456'}});\n` +
      `return st.project.id;`
  }
})
const completedObj = JSON.parse(completed.result.content[0].text)
const afterComplete = await evalJs(`(async()=>{
  const st=window.kadrEditor.useEditor.getState()
  const task=window.kadrEditor.getAnnotationTasks().find((item)=>item.id==='${mcpTask.id}')
  return {start:task.start,status:task.status,result:task.result,background:st.project.background,
    undoLabel:st.past[st.past.length-1]?.label}
})()`)
check('MCP completion preserves the user-moved timing and writes result/status',
  concurrent === 22 && afterComplete.start === 22 && afterComplete.status === 'done' &&
  afterComplete.result.includes('обновлён') && completedObj.task.id === mcpTask.id,
  JSON.stringify(afterComplete))
check('agent edit and completion form one undo entry',
  afterComplete.background === '#123456' && afterComplete.undoLabel === 'hAnnotationAgent')

const undone = await evalJs(`(async()=>{
  window.kadrEditor.useEditor.getState().undo(); await new Promise(requestAnimationFrame)
  const st=window.kadrEditor.useEditor.getState()
  const task=window.kadrEditor.getAnnotationTasks().find((item)=>item.id==='${mcpTask.id}')
  return {start:task.start,status:task.status,background:st.project.background}
})()`)
check('one undo reverts agent edits/status but keeps the concurrent user timing',
  undone.start === 22 && undone.status === 'new' && undone.background === '#000000', JSON.stringify(undone))

// Deleted while working: completion must fail and must not resurrect the task.
const doomed = await evalJs(`(async()=>{
  const st=window.kadrEditor.useEditor.getState(); st.setPlayhead(30); const id=st.insertAnnotation(30)
  st.updateAnnotation(id,{text:'Удаляемая задача'}); st.setAnnotation(null); return id
})()`)
await mcpCall('tools/call', { name: 'kadr_task_start', arguments: { id: doomed } })
await evalJs(`(async()=>window.kadrEditor.useEditor.getState().deleteAnnotation('${doomed}'))()`)
const missing = await mcpCall('tools/call', {
  name: 'kadr_task_complete', arguments: { id: doomed, result: 'Не должно сохраниться' }
})
const stillMissing = await evalJs(`(async()=>!window.kadrEditor.getAnnotationTasks().some((task)=>task.id==='${doomed}'))()`)
check('deleted task returns an MCP error and is never recreated', missing.result?.isError === true && stillMissing)

mcp.kill()
await evalJs(`(async()=>window.kadr.claudeClose())()`)
ws.close()
console.log('e2e32 finished')
