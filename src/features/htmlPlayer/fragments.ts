import type { Clip, Project, Track } from '@shared/types'
import { evalAnim } from '@/engine/anim'
import { fadeFactor } from '@/engine/player'

interface FragmentEntry {
  clip: Clip
  track: Track
  trackIndex: number
  clipIndex: number
  iframe: HTMLIFrameElement | null
}

export interface FragmentRuntime {
  update(playhead: number, playing: boolean, masterVolume: number, force?: boolean): void
  destroy(): void
}

/** Live Remotion layers for a portable HTML export. The exported bundle is
 * driven by the same sync protocol as Kadr's editor preview; no frames are
 * rendered during export. */
export function createFragmentRuntime(
  project: Project,
  container: HTMLElement
): FragmentRuntime {
  const entries: FragmentEntry[] = []
  for (let trackIndex = 0; trackIndex < project.tracks.length; trackIndex++) {
    const track = project.tracks[trackIndex]
    if (track.kind !== 'video') continue
    for (let clipIndex = 0; clipIndex < track.clips.length; clipIndex++) {
      const clip = track.clips[clipIndex]
      if (clip.kind === 'remotion' && clip.fragmentId) {
        entries.push({ clip, track, trackIndex, clipIndex, iframe: null })
      }
    }
  }

  let lastPlayhead = 0
  let lastPlaying = false
  let lastMasterVolume = 1
  let lastSyncAt = 0

  const ensureFrame = (entry: FragmentEntry): HTMLIFrameElement => {
    if (entry.iframe) return entry.iframe
    const frame = document.createElement('iframe')
    frame.className = 'kadr-fragment-frame'
    frame.title = entry.clip.label ?? entry.clip.fragmentId ?? 'Remotion'
    frame.src = new URL(
      `fragments/index.html?comp=${encodeURIComponent(entry.clip.fragmentId!)}`,
      document.baseURI
    ).href
    frame.allow = 'autoplay'
    frame.style.zIndex = String((project.tracks.length - entry.trackIndex) * 1000 + entry.clipIndex)
    container.appendChild(frame)
    entry.iframe = frame
    frame.addEventListener('load', () => update(lastPlayhead, lastPlaying, lastMasterVolume, true))
    return frame
  }

  const removeFrame = (entry: FragmentEntry): void => {
    entry.iframe?.remove()
    entry.iframe = null
  }

  const update = (
    playhead: number,
    playing: boolean,
    masterVolume: number,
    force = false
  ): void => {
    lastPlayhead = playhead
    lastPlaying = playing
    lastMasterVolume = masterVolume
    const now = performance.now()
    const postSync = force || !playing || now - lastSyncAt >= 200
    if (postSync) lastSyncAt = now

    for (const entry of entries) {
      const { clip, track } = entry
      const rel = playhead - clip.start
      const near = !track.muted && rel >= -1.5 && rel < clip.duration + 0.5
      if (!near) {
        removeFrame(entry)
        continue
      }
      const frame = ensureFrame(entry)
      const active = rel >= 0 && rel < clip.duration
      const localTime = Math.max(0, Math.min(clip.duration, rel))
      const meta = clip.fragmentMeta
      const sourceWidth = meta?.width ?? project.width
      const sourceHeight = meta?.height ?? project.height
      const fit = Math.min(project.width / sourceWidth, project.height / sourceHeight)
      const scale = evalAnim(clip.transform.scale, localTime) * fit
      const x = project.width / 2 + evalAnim(clip.transform.x, localTime)
      const y = project.height / 2 + evalAnim(clip.transform.y, localTime)
      const rotation = evalAnim(clip.transform.rotation, localTime)
      const trackOpacity = Math.min(1, Math.max(0, track.gain ?? 1))
      const opacity = active
        ? evalAnim(clip.transform.opacity, localTime) * fadeFactor(clip, localTime) * trackOpacity
        : 0

      frame.style.left = `${x / project.width * 100}%`
      frame.style.top = `${y / project.height * 100}%`
      frame.style.width = `${sourceWidth * scale / project.width * 100}%`
      frame.style.height = `${sourceHeight * scale / project.height * 100}%`
      frame.style.transform = `translate(-50%, -50%)${rotation ? ` rotate(${rotation}deg)` : ''}`
      frame.style.opacity = String(Math.max(0, Math.min(1, opacity)))
      frame.style.visibility = opacity > 0.001 ? 'visible' : 'hidden'

      if (postSync) {
        const fps = meta?.fps ?? project.fps
        const volume = clip.muted || !active
          ? 0
          : Math.min(
              1,
              Math.max(0, masterVolume * evalAnim(clip.gain, localTime) * track.gain * fadeFactor(clip, localTime))
            )
        frame.contentWindow?.postMessage({
          kadr: true,
          type: 'sync',
          frame: Math.max(0, Math.round((localTime * (clip.speed || 1) + clip.inPoint) * fps)),
          playing: playing && active,
          volume
        }, '*')
      }
    }
  }

  const onReady = (event: MessageEvent): void => {
    if (!event.data?.kadr || event.data.type !== 'ready') return
    if (entries.some((entry) => entry.iframe?.contentWindow === event.source)) {
      update(lastPlayhead, lastPlaying, lastMasterVolume, true)
    }
  }
  window.addEventListener('message', onReady)

  return {
    update,
    destroy: () => {
      window.removeEventListener('message', onReady)
      for (const entry of entries) removeFrame(entry)
    }
  }
}
