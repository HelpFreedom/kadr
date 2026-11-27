import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ptyDir = dirname(require.resolve('node-pty/package.json'))
const prebuild = join(ptyDir, 'prebuilds', process.platform + '-' + process.arch)
const windowsBinaries = ['conpty.node', 'conpty_console_list.node', 'pty.node',
  'conpty/conpty.dll', 'conpty/OpenConsole.exe']
const usePrebuild = process.platform === 'win32' &&
  process.env.npm_config_build_from_source !== 'true' &&
  windowsBinaries.every((name) => existsSync(join(prebuild, name)))

if (usePrebuild) {
  // The npm package bundles Node-API binaries for Windows.
  console.log('[kadr] Using the Windows node-pty prebuild from npm.')
} else {
  const { rebuild } = await import('@electron/rebuild')
  await rebuild({
    buildPath: fileURLToPath(new URL('..', import.meta.url)),
    electronVersion: require('electron/package.json').version,
    force: true,
    onlyModules: ['node-pty']
  })
}
