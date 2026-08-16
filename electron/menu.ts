import { app, Menu, shell, BrowserWindow } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/types'

const isMac = process.platform === 'darwin'

const LABELS = {
  en: {
    file: 'File', newProject: 'New Project', openProject: 'Open Project…',
    save: 'Save', saveAs: 'Save As…', export: 'Export…', edit: 'Edit',
    undo: 'Undo', redo: 'Redo', view: 'View', window: 'Window',
    help: 'Help', github: 'Kadr on GitHub'
  },
  ru: {
    file: 'Файл', newProject: 'Новый проект', openProject: 'Открыть проект…',
    save: 'Сохранить', saveAs: 'Сохранить как…', export: 'Экспорт…', edit: 'Правка',
    undo: 'Отменить', redo: 'Повторить', view: 'Вид', window: 'Окно',
    help: 'Справка', github: 'Kadr на GitHub'
  }
} as const

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
  const labels = app.getLocale().toLowerCase().startsWith('ru') ? LABELS.ru : LABELS.en
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
        { label: labels.newProject, accelerator: 'CmdOrCtrl+N', click: send('new') },
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
        { role: 'cut' },
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
