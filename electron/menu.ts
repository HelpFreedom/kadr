import { app, Menu, shell, BrowserWindow } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

const isMac = process.platform === 'darwin'

/**
 * The application menu. File/Edit project commands are forwarded to the
 * renderer over `menu:command` so they reuse the exact same handlers the
 * toolbar buttons call — the menu is purely a native entry point with
 * proper Cmd/Ctrl accelerators (macOS users finally get ⌘S/⌘Z/…).
 *
 * Clipboard/selection keep their standard roles so text inputs and the
 * embedded Claude terminal behave natively; project-level undo/redo are
 * custom items (the app's real history lives in the zustand store, not the
 * DOM) and the renderer falls back to text undo when an input is focused.
 */
export function buildMenu(getWin: () => BrowserWindow | null): Menu {
  const send = (cmd: string) => () => getWin()?.webContents.send('menu:command', cmd)

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { role: 'services' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
            { type: 'separator' as const },
            { role: 'quit' as const }
          ]
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('saveAs') },
        { type: 'separator' },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: send('export') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Kadr on GitHub',
          click: () => shell.openExternal('https://github.com/HelpFreedom/kadr')
        }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}
