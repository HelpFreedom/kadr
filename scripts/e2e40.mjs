// Test: the design-system contract of the interface itself.
//
// The redesign introduced three things that are easy to break by accident and
// invisible in every other suite: the token layer (no rule may invent a
// colour), keyboard access (focus rings, a real dialog trap, Escape) and the
// no-emoji rule (controls are lucide SVG, addressed by data-act). Each of
// these was measured to be ABSENT before the redesign, so this suite is the
// thing that keeps them.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
import WebSocket from 'ws'

const PORT = process.env.KADR_CDP_PORT || 9777

async function getPageWs() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page' && t.url.includes('localhost'))
      if (page) return page.webSocketDebuggerUrl
    } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('CDP target not found')
}

let id = 0
let ws
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    const onMsg = (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id !== msgId) return
      ws.off('message', onMsg)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}
async function rawEval(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error('JS exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result.value
}
async function evalJs(expression, { timeout = 60000 } = {}) {
  const key = `k${Date.now()}_${++id}`
  await rawEval(
    `window.__e2e = window.__e2e || {};` +
    `(async () => { try { window.__e2e.${key} = JSON.stringify({ ok: await (${expression}) }) }` +
    ` catch (e) { window.__e2e.${key} = JSON.stringify({ err: String((e && e.message) || e) }) } })(); 0`
  )
  const t0 = Date.now()
  for (;;) {
    const raw = await rawEval(`window.__e2e.${key} ?? null`)
    if (raw !== null) {
      const r = JSON.parse(raw)
      if ('err' in r) throw new Error('JS exception: ' + r.err)
      return r.ok
    }
    if (Date.now() - t0 > timeout) throw new Error('eval timeout')
    await new Promise((r) => setTimeout(r, 300))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}
const key = (k, code, mods = 0) =>
  send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: 0, modifiers: mods })
    .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mods }))

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

try {
  // ---- 1. the token layer exists and every semantic token resolves
  const tokens = await evalJs(`(() => {
    const cs = getComputedStyle(document.documentElement)
    const want = ['--c-bg-0','--c-bg-1','--c-bg-2','--c-text','--c-text-2','--c-text-3',
      '--c-accent','--c-accent-solid','--c-line','--c-line-ctl','--c-ok','--c-warn','--c-danger',
      '--c-sel','--c-playhead','--c-marker','--c-defect','--c-redo',
      '--s1','--s4','--s8','--r1','--r4','--t-fast','--t-base','--font','--font-mono']
    const missing = want.filter((t) => !cs.getPropertyValue(t).trim())
    return { missing, accent: cs.getPropertyValue('--c-accent').trim() }
  })()`)
  check('every semantic token resolves', tokens.missing.length === 0, tokens.missing.join(', '))

  // No stylesheet rule may carry its own colour: the palette has exactly one
  // home, and a stray hex is how two different blues got into the old UI.
  const stray = await evalJs(`(() => {
    const out = []
    for (const sheet of document.styleSheets) {
      let rules
      try { rules = sheet.cssRules } catch { continue }   // cross-origin
      const walk = (list) => {
        for (const r of list) {
          // NB a plain style rule ALSO has .cssRules since CSS nesting landed,
          // so "has children => it is a group" skips every rule there is. Test
          // the declarations first, then descend into whatever is nested.
          if (r.style && r.selectorText !== ':root') {
            const text = r.cssText.replace(/var\\([^)]*\\)/g, '')
            if (/#[0-9a-fA-F]{3,8}\\b|rgba?\\(\\s*\\d/.test(text)) out.push(r.selectorText)
          }
          if (r.cssRules && r.cssRules.length) walk(r.cssRules)
        }
      }
      walk(rules)
    }
    return out
  })()`)
  // xterm.js ships its own stylesheet; only Kadr's rules are ours to keep clean
  const ours = stray.filter((s) => !/xterm/.test(s))
  check('no rule outside :root carries its own colour', ours.length === 0, ours.slice(0, 4).join(' | '))

  // ---- 2. no emoji anywhere in the rendered interface
  const emoji = await evalJs(`(() => {
    // the range matters: a stray U+27F2 once slipped through a narrower one
    const re = /[\\u{1F000}-\\u{1FAFF}\\u{2190}-\\u{2BFF}\\u{2900}-\\u{297F}]/u
    const hits = []
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (re.test(n.nodeValue)) hits.push(n.nodeValue.trim().slice(0, 30))
    }
    return hits
  })()`)
  check('the interface draws no emoji', emoji.length === 0, emoji.slice(0, 3).join(' | '))

  const icons = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('.topbar button, .transport button, .tl-toolbar button')]
    const iconOnly = btns.filter((b) => !b.textContent.trim())
    return {
      total: btns.length,
      withSvg: btns.filter((b) => b.querySelector('svg.ico')).length,
      namelessIconOnly: iconOnly.filter((b) => !b.getAttribute('aria-label') && !b.title).length,
      withAct: iconOnly.filter((b) => b.dataset.act).length,
      iconOnly: iconOnly.length
    }
  })()`)
  check('the chrome is drawn with the icon set', icons.withSvg >= 12, JSON.stringify(icons))
  check('every icon-only button still has a name for a screen reader',
        icons.namelessIconOnly === 0, JSON.stringify(icons))
  check('and a data-act handle to address it by', icons.withAct === icons.iconOnly, JSON.stringify(icons))

  // ---- 3. keyboard focus is visible (there was no focus style at all before).
  // :focus-visible only lights up in keyboard modality, so this has to be a
  // REAL Tab: a scripted .focus() may or may not count, depending on what the
  // user did last, and would make the check a coin toss.
  await evalJs(`(() => { document.body.focus(); document.querySelector('.brand').setAttribute('tabindex', '-1'); document.querySelector('.brand').focus(); return 1 })()`)
  await key('Tab', 'Tab')
  await new Promise((r) => setTimeout(r, 200))
  const ring = await evalJs(`(() => {
    const el = document.activeElement
    const cs = getComputedStyle(el)
    document.querySelector('.brand').removeAttribute('tabindex')
    return { tag: el.tagName, cls: el.className, width: cs.outlineWidth,
             style: cs.outlineStyle, color: cs.outlineColor }
  })()`)
  check('a control focused from the keyboard shows a ring',
        ring.tag !== 'BODY' && parseFloat(ring.width) >= 2 && ring.style === 'solid',
        JSON.stringify(ring))

  // ---- 4. dialogs: labelled, escapable, and they own the keyboard
  const dlg = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    st().setPlaying(false)
    st().setExportOpen(true)
    await new Promise((r) => setTimeout(r, 400))
    const box = document.querySelector('.modal')
    const labelId = box && box.getAttribute('aria-labelledby')
    return {
      role: box && box.getAttribute('role'),
      modal: box && box.getAttribute('aria-modal'),
      labelled: !!(labelId && document.getElementById(labelId)?.textContent.trim()),
      focusInside: !!box && box.contains(document.activeElement),
      hasClose: !!box.querySelector('.modal-close'),
      playing: st().playing
    }
  })()`)
  check('a dialog is a dialog for assistive tech', dlg.role === 'dialog' && dlg.modal === 'true' && dlg.labelled,
        JSON.stringify(dlg))
  check('opening one moves focus into it', dlg.focusInside === true)

  // Space used to press the focused button AND start playback behind the dialog
  await key(' ', 'Space')
  await new Promise((r) => setTimeout(r, 300))
  const quiet = await evalJs(`window.kadrEditor.useEditor.getState().playing`)
  check('global shortcuts are suppressed while a dialog is open', quiet === false, `playing=${quiet}`)

  // Tab must cycle inside the dialog, never out into the editor behind it
  const trapped = await evalJs(`(() => {
    const box = document.querySelector('.modal')
    const items = [...box.querySelectorAll('button, input, select, textarea')]
    items[items.length - 1].focus()
    return { last: document.activeElement === items[items.length - 1], n: items.length }
  })()`)
  await key('Tab', 'Tab')
  await new Promise((r) => setTimeout(r, 200))
  const stillIn = await evalJs(`(() => {
    const box = document.querySelector('.modal')
    return { inside: !!box && box.contains(document.activeElement), tag: document.activeElement.tagName }
  })()`)
  check('Tab off the last control wraps back into the dialog',
        trapped.last && stillIn.inside === true, JSON.stringify({ trapped, stillIn }))

  await key('Escape', 'Escape')
  await new Promise((r) => setTimeout(r, 400))
  const closed = await evalJs(`({ open: window.kadrEditor.useEditor.getState().exportOpen,
                                  dom: !!document.querySelector('.modal') })`)
  check('Escape closes it', closed.open === false && closed.dom === false, JSON.stringify(closed))

  // ---- 5. reduced motion is honoured
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await new Promise((r) => setTimeout(r, 300))
  const reduced = await evalJs(`(() => {
    const el = document.createElement('div')
    el.className = 'spinner'
    document.body.appendChild(el)
    const d = getComputedStyle(el).animationDuration
    el.remove()
    return d
  })()`)
  check('reduced motion stops the spinner', parseFloat(reduced) < 0.01, `duration=${reduced}`)
  await send('Emulation.setEmulatedMedia', { features: [] })
  await new Promise((r) => setTimeout(r, 200))
  const normal = await evalJs(`(() => {
    const el = document.createElement('div')
    el.className = 'spinner'
    document.body.appendChild(el)
    const d = getComputedStyle(el).animationDuration
    el.remove()
    return d
  })()`)
  check('and it spins again once the preference is gone', parseFloat(normal) > 0.1, `duration=${normal}`)

  // ---- 6. contrast of the text the user actually reads, measured in the page
  const contrast = await evalJs(`(() => {
    const lum = (c) => {
      const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map((v) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
      return (x + 0.05) / (y + 0.05)
    }
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor
        if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) return c
      }
      return 'rgb(0,0,0)'
    }
    const out = []
    for (const sel of ['.brand', '.project-name', '.panel-head', '.insp-field > span',
                       '.hint', '.hint-inline', '.transport .time', '.ruler span', '.track-name']) {
      const el = document.querySelector(sel)
      if (!el) continue
      out.push({ sel, r: +ratio(getComputedStyle(el).color, bgOf(el)).toFixed(2) })
    }
    return out
  })()`)
  const worst = contrast.reduce((a, b) => (b.r < a.r ? b : a), { sel: '-', r: 99 })
  check('every text style in the chrome clears AA (4.5:1)', worst.r >= 4.5,
        JSON.stringify(contrast))

  // ---- 7. the timeline's scrollbar: visible, and grabbable at ANY zoom.
  // The bar the editor is driven with was a 10px system one with a #242a36
  // thumb on a #101319 panel — 1.4:1, and it shrank with the zoom until there
  // was nothing left to catch. Both halves of that are measured here.
  const sb = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    st().setProject({ ...st().project, tracks: [{ id: 'sbv', kind: 'video', name: 'V1',
      muted: false, locked: false, gain: 1, clips: [] }], assets: [] }, null)
    st().setZoom(4000)
    await new Promise((r) => setTimeout(r, 700))
    const el = document.querySelector('.tl-scroll')
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const thickness = el.offsetHeight - el.clientHeight
    return {
      // THE regression to catch: any scrollbar-width/-color other than auto
      // hands the bar back to the standard path and silently drops every
      // ::-webkit-scrollbar rule, size and minimum included
      styledPath: cs.scrollbarWidth === 'auto' && cs.scrollbarColor === 'auto',
      thickness,
      proportional: +(el.clientWidth * el.clientWidth / el.scrollWidth).toFixed(1),
      left: Math.round(r.left),
      width: Math.round(r.width),
      barTop: Math.round(r.bottom) - thickness
    }
  })()`)
  check('the timeline scrollbar is the one we style, not the system one',
        sb.styledPath === true, JSON.stringify(sb))
  check('it is thicker than the default bar', sb.thickness >= 14, `${sb.thickness}px`)
  check('the zoom would otherwise leave nothing to grab', sb.proportional < 40,
        `proportional thumb would be ${sb.proportional}px`)

  // what is actually painted: clip a screenshot to the bar and read the row
  const strip = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: sb.left, y: sb.barTop, width: sb.width, height: sb.thickness, scale: 1 }
  })
  await rawEval(`window.__sbShot = ${JSON.stringify(strip.data)}; 0`)
  const painted = await evalJs(`(async () => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + window.__sbShot
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const row = g.getImageData(0, Math.floor(img.height / 2), img.width, 1).data
    const px = []
    for (let x = 0; x < img.width; x++) px.push([row[x * 4], row[x * 4 + 1], row[x * 4 + 2]])
    // the thumb is whatever is clearly lighter than the groove behind it
    const lit = px.map((p, x) => [p, x]).filter(([p]) => p[0] + p[1] + p[2] > 180).map(([, x]) => x)
    let widest = 0, run = 0, colour = null
    for (let x = 0; x < img.width; x++) {
      if (lit.includes(x)) { run++; if (run > widest) { widest = run; colour = px[x] } }
      else run = 0
    }
    const groove = px[Math.floor(img.width * 0.75)]
    const lum = (p) => {
      const [r, gg, b] = p.map((v) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
      })
      return 0.2126 * r + 0.7152 * gg + 0.0722 * b
    }
    const [hi, lo] = [lum(colour || [0, 0, 0]), lum(groove)].sort((a, b) => b - a)
    delete window.__sbShot
    return { thumbPx: widest, colour, groove, contrast: +((hi + 0.05) / (lo + 0.05)).toFixed(2) }
  })()`)
  check('the thumb keeps a size the hand can catch', painted.thumbPx >= 48,
        `${painted.thumbPx}px painted where the proportional one is ${sb.proportional}px`)
  check('and it is clearly lighter than its groove (3:1)', painted.contrast >= 3,
        JSON.stringify(painted))

} finally {
  ws.close()
}
console.log('e2e40 finished')
