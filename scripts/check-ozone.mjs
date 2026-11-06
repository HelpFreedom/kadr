// Node-side check of shared/ozone.ts — whether Electron's window will be a
// Wayland one. The NVIDIA EGL vendor that the discrete-GPU choice needs blacks
// out a Wayland window (HelpFreedom/kadr#44), so the dev launcher and
// electron/gpu.ts keep it for an X11 window only.
// Run: node scripts/check-ozone.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = transformSync(readFileSync(join(root, 'shared', 'ozone.ts'), 'utf8'), { loader: 'ts', format: 'esm' }).code
const { waylandWindow } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) fails++
}

const WL = { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' }
const X = { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }
for (const [name, env, argv, want] of [
  ['a Wayland session, nothing forced → Wayland', WL, ['electron', '.'], true],
  ['… with --ozone-platform=x11 → X11', WL, ['electron', '--remote-debugging-port=9777', '--ozone-platform=x11', '.'], false],
  ['… with --ozone-platform-hint=x11 → X11', WL, ['electron', '--ozone-platform-hint=x11'], false],
  ['… with ELECTRON_OZONE_PLATFORM_HINT=x11 → X11', { ...WL, ELECTRON_OZONE_PLATFORM_HINT: 'x11' }, [], false],
  ['… with --ozone-platform-hint=auto → Wayland', WL, ['--ozone-platform-hint=auto'], true],
  ['… the command line wins over the variable', { ...WL, ELECTRON_OZONE_PLATFORM_HINT: 'wayland' }, ['--ozone-platform=x11'], false],
  ['an X11 session → X11', X, ['electron', '.'], false],
  ['an X11 session forced to Wayland → Wayland', X, ['--ozone-platform=wayland'], true],
  ['only XDG_SESSION_TYPE says wayland → Wayland (the careful answer)', { XDG_SESSION_TYPE: 'wayland' }, [], true],
  ['the dev launcher\'s own argv (electron-vite dev -- … x11) → X11', WL, ['node', 'electron-vite', 'dev', '--', '--ozone-platform=x11'], false]
]) {
  check(name, waylandWindow(env, argv) === want)
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
