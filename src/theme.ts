/**
 * Design tokens for the surfaces CSS cannot reach.
 *
 * The waveform, the audio meter and the embedded terminal are drawn by hand
 * (canvas / xterm), so they used to carry their own hex literals and drifted
 * away from the rest of the interface. They read the same `:root` tokens now.
 * Values are cached: the palette is fixed for the life of the window.
 */
const cache = new Map<string, string>()

export function token(name: string, fallback = ''): string {
  const hit = cache.get(name)
  if (hit !== undefined) return hit
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  cache.set(name, v)
  return v
}
