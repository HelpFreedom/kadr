// The one route the renderer writes a user store through (pose/fx presets,
// voice-over settings, recent projects). A failed write used to be swallowed
// with only the localStorage cache keeping the change, so the user never
// learned the file on disk was stale. It still does not throw — the cache
// stays the fallback — but the failure reaches the session log with the path.
import { logWarn } from './log'
import { tr } from '../i18n'

/** Electron wraps a handler's error as «Error invoking remote method 'x': Error: …». */
const IPC_PREFIX = /^Error invoking remote method '[^']*': (?:\w*Error: )?/

export function saveUserStore(name: string, data: unknown): Promise<boolean> {
  return window.kadr.writeUserStore(name, data).then(
    () => true,
    (err) => {
      const why = String((err as Error)?.message ?? err).replace(IPC_PREFIX, '')
      logWarn(tr('logStore'), `${tr('storeWriteFail')}: ${why}`, err)
      return false
    }
  )
}
