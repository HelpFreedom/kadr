const platform = typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent

export const IS_MAC = /^Mac/.test(platform)
export const PRIMARY_MODIFIER = IS_MAC ? '⌘' : 'Ctrl'

export function hasPrimaryModifier(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return IS_MAC ? event.metaKey : event.ctrlKey
}

export function shortcut(key: string, shift = false): string {
  const normalized = key.toUpperCase()
  if (IS_MAC) return `${shift ? '⇧' : ''}⌘${normalized}`
  return `Ctrl+${shift ? 'Shift+' : ''}${normalized}`
}
