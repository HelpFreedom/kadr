import { app, Menu, shell, BrowserWindow } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/types'

const isMac = process.platform === 'darwin'

const LABELS = {
  en: {
    file: 'File', newWindow: 'New Window', newProject: 'New Project', openProject: 'Open Project…',
    save: 'Save', saveAs: 'Save As…', export: 'Export…', edit: 'Edit',
    undo: 'Undo', redo: 'Redo', cut: 'Cut', view: 'View', window: 'Window',
    help: 'Help', github: 'Kadr on GitHub'
  },
  ru: {
    file: 'Файл', newWindow: 'Новое окно', newProject: 'Новый проект', openProject: 'Открыть проект…',
    save: 'Сохранить', saveAs: 'Сохранить как…', export: 'Экспорт…', edit: 'Правка',
    undo: 'Отменить', redo: 'Повторить', cut: 'Вырезать', view: 'Вид', window: 'Окно',
    help: 'Справка', github: 'Kadr на GitHub'
  }
} as const

/**
 * The application menu. File/Edit project commands are forwarded to the
 * renderer over `menu:command` so they reuse the exact same handlers the
 * toolbar buttons call — the menu is purely a native entry point with
 * proper Cmd/Ctrl accelerators (macOS users finally get ⌘S/⌘Z/…).
 *
 * Copy/paste/selection keep their standard roles. Cut is forwarded so it can
 * target timeline clips, with a renderer-side fallback to native text cutting
 * for inputs and the embedded terminal. Project-level undo/redo are custom too
 * because the app's real history lives in the zustand store, not the DOM.
 */
function localizedLabels() {
  return app.getLocale().toLowerCase().startsWith('ru') ? LABELS.ru : LABELS.en
}

export function buildMenu(
  getWin: () => BrowserWindow | null,
  createWindow: () => BrowserWindow
): Menu {
  const labels = localizedLabels()
  const send = (cmd: MenuCommand) => () => getWin()?.webContents.send('menu:command', cmd)

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
      label: labels.file,
      submenu: [
        { label: labels.newWindow, accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: labels.newProject, accelerator: 'CmdOrCtrl+Shift+N', click: send('new') },
        { label: labels.openProject, accelerator: 'CmdOrCtrl+O', click: send('open') },
        { type: 'separator' },
        { label: labels.save, accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: labels.saveAs, accelerator: 'CmdOrCtrl+Shift+S', click: send('saveAs') },
        { type: 'separator' },
        { label: labels.export, accelerator: 'CmdOrCtrl+E', click: send('export') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: labels.edit,
      submenu: [
        { label: labels.undo, accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: labels.redo, accelerator: 'CmdOrCtrl+Shift+Z', click: send('redo') },
        { type: 'separator' },
        { label: labels.cut, accelerator: 'CmdOrCtrl+X', click: send('cut') },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: labels.view,
      submenu: [
        ...(app.isPackaged
          ? []
          : [
              { role: 'reload' as const },
              { role: 'forceReload' as const },
              { role: 'toggleDevTools' as const },
              { type: 'separator' as const }
            ]),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: labels.window,
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    },
    {
      label: labels.help,
      role: 'help',
      submenu: [
        {
          label: labels.github,
          click: () => shell.openExternal('https://github.com/HelpFreedom/kadr')
        }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}

export function buildDockMenu(createWindow: () => BrowserWindow): Menu {
  const labels = localizedLabels()
  return Menu.buildFromTemplate([
    { label: labels.newWindow, click: () => createWindow() }
  ])
}
