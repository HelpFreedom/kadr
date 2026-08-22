// Storyboard, adaptive timeline filmstrip, and proxy recovery smoke test.
// Run Kadr with --remote-debugging-port first; uses /tmp/kadr-test/hd.mp4.
import WebSocket from 'ws'
import { statSync, writeFileSync } from 'fs'

const PORT = Number(process.env.KADR_CDP_PORT || 9788)
const TEST_FRAGMENT = process.env.KADR_TEST_FRAGMENT || ''

async function pageSocket() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = pages.find((item) => item.type === 'page' && item.url.includes('localhost'))
      if (page) return page.webSocketDebuggerUrl
    } catch { /* app starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Kadr CDP page not found')
}

let id = 0
const ws = new WebSocket(await pageSocket())
await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id
    const onMessage = (raw) => {
      const message = JSON.parse(raw)
      if (message.id !== requestId) return
      ws.off('message', onMessage)
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id: requestId, method, params }))
  })
}

async function rawEval(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  }
  return result.result.value
}

async function evaluate(expression, timeout = 120000) {
  const key = `media_visual_${Date.now()}_${++id}`
  await rawEval(
    `window.__e2e=window.__e2e||{};` +
    `(async()=>{try{window.__e2e.${key}=JSON.stringify({ok:await(${expression})})}` +
    `catch(e){window.__e2e.${key}=JSON.stringify({error:String(e?.stack||e)})}})();0`
  )
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const raw = await rawEval(`window.__e2e.${key} ?? null`)
    if (raw != null) {
      const parsed = JSON.parse(raw)
      if (parsed.error) throw new Error(parsed.error)
      return parsed.ok
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('renderer evaluation timed out')
}

function check(name, condition, details = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${details ? `  (${details})` : ''}`)
  if (!condition) process.exitCode = 1
}

const result = await evaluate(`(async()=>{
  const ed=window.kadrEditor
  const trackId=ed.uid()
  ed.useEditor.getState().setProject({
    version:1,id:ed.uid(),name:'Visual cache E2E',width:1280,height:720,fps:30,
    background:'#101216',tracks:[{id:trackId,kind:'video',name:'V1',muted:false,locked:false,gain:1,clips:[]}],
    assets:[]
  })
  ed.useEditor.getState().setZoom(60)
  await ed.importFiles(['/tmp/kadr-test/hd.mp4'],{trackId,at:0})
  const asset=ed.useEditor.getState().project.assets[0]
  const direct=await window.kadr.timelineThumbnails({
    kind:'media',sourcePath:asset.path,times:[0,2,4],width:160,height:90,cacheKey:'e2e'
  })
  const fragmentId=${JSON.stringify(TEST_FRAGMENT)}
  const remotion=fragmentId?{
    fingerprint:await window.kadr.visualFingerprint([],[fragmentId]),
    frames:await window.kadr.timelineThumbnails({
      kind:'remotion',fragmentId,times:[0,1],width:160,height:90,cacheKey:'e2e-remotion'
    })
  }:null
  for(let i=0;i<150&&!document.querySelector('.clip-filmstrip-frame');i++)
    await new Promise((resolve)=>setTimeout(resolve,100))
  const clipEl=document.querySelector('.clip.video')
  const timelineEl=document.querySelector('.tl-scroll')
  const coarseFilmstrip=document.querySelectorAll('.clip-filmstrip-frame').length
  ed.useEditor.getState().setZoom(180)
  for(let i=0;i<150&&document.querySelectorAll('.clip-filmstrip-frame').length<=coarseFilmstrip;i++)
    await new Promise((resolve)=>setTimeout(resolve,100))
  const detailedFilmstrip=document.querySelectorAll('.clip-filmstrip-frame').length
  const filmstripLoaded=[...document.querySelectorAll('.clip-filmstrip-frame')]
    .every((img)=>img.complete&&img.naturalWidth>0&&img.naturalHeight>0)
  const first=await ed.storyboardFrames({start:0,end:4,maxFrames:3})
  const cached=await ed.storyboardFrames({start:0,end:4,maxFrames:3})
  ed.useEditor.getState().setProject({...ed.useEditor.getState().project,background:'#283040'})
  const changed=await ed.storyboardFrames({start:0,end:4,maxFrames:3})
  const proxy=await window.kadr.rebuildProxy(asset.path,asset.duration)
  return {
    direct:direct.map((frame)=>({time:frame.time,size:frame.dataUrl.length})),
    filmstrip:detailedFilmstrip,coarseFilmstrip,filmstripLoaded,
    filmstripContainers:document.querySelectorAll('.clip-filmstrip').length,
    posters:document.querySelectorAll('.clip-thumb').length,
    clipKind:ed.useEditor.getState().project.tracks.flatMap((track)=>track.clips)[0]?.kind,
    assetKind:ed.useEditor.getState().project.assets[0]?.kind,
    zoom:ed.useEditor.getState().zoom,
    clipRect:clipEl?{width:clipEl.getBoundingClientRect().width,left:clipEl.getBoundingClientRect().left}:null,
    timelineRect:timelineEl?{width:timelineEl.getBoundingClientRect().width,left:timelineEl.getBoundingClientRect().left}:null,
    remotion,first,cached,changed,proxy
  }
})()`)

let recoveredProxy = null
if (result.proxy.includes('/kadr-feature-e2e/proxies/')) {
  writeFileSync(result.proxy, 'deliberately corrupt proxy cache')
  recoveredProxy = await evaluate(`window.kadr.requestProxy(${JSON.stringify('/tmp/kadr-test/hd.mp4')},8)`)
}

check('timeline thumbnail IPC returns three real images',
  result.direct.length === 3 && result.direct.every((frame) => frame.size > 500),
  JSON.stringify(result.direct))
if (TEST_FRAGMENT) check('Remotion filmstrip frames render and are fingerprinted',
  result.remotion?.fingerprint?.length > 10 && result.remotion.frames.length === 2 &&
    result.remotion.frames.every((frame) => frame.dataUrl.length > 500))
check('adaptive filmstrip renders inside the visible clip', result.filmstrip >= 2,
  JSON.stringify({frames:result.filmstrip,containers:result.filmstripContainers,posters:result.posters,
    clipKind:result.clipKind,assetKind:result.assetKind,zoom:result.zoom,clipRect:result.clipRect,timelineRect:result.timelineRect}))
check('filmstrip images decode in Chromium', result.filmstripLoaded)
check('zooming in requests a denser filmstrip', result.filmstrip > result.coarseFilmstrip,
  `${result.coarseFilmstrip} -> ${result.filmstrip}`)
check('storyboard writes a contact sheet and individual source-quality frames',
  result.first.contactSheetPath.includes('/storyboards/') && result.first.frames.length === 3 &&
    statSync(result.first.contactSheetPath).size > 1000 &&
    result.first.frames.every((frame) => statSync(frame.path).size > 1000))
check('identical current fingerprint reuses the storyboard generation',
  result.cached.cached === true && result.cached.contactSheetPath === result.first.contactSheetPath)
check('visual edits invalidate the storyboard automatically',
  result.changed.cached === false && result.changed.fingerprint !== result.first.fingerprint)
check('forced proxy rebuild publishes a playable cache file', statSync(result.proxy).size > 1000, result.proxy)
if (recoveredProxy) check('a corrupt cached proxy is detected and rebuilt automatically',
  recoveredProxy === result.proxy && statSync(recoveredProxy).size > 1000, recoveredProxy)

ws.close()
