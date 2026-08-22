import { DEFAULT_HTML_PLAYER_SETTINGS } from '@shared/types'
import type { HtmlPlayerSettings, Project } from '@shared/types'
import { Player } from '@/engine/player'
import { setMasterGain } from '@/engine/audio'
import { createFragmentRuntime, type FragmentRuntime } from './fragments'
import { createAssetPreloader, type FragmentAssetRef } from './preloader'
import { createFileAssetBridge } from './fileAssets'

interface PlayerState {
  project: Project
  playhead: number
  playing: boolean
  loading: boolean
}

interface Labels {
  play: string
  pause: string
  restart: string
  mute: string
  unmute: string
  volume: string
  fullscreen: string
  exitFullscreen: string
  loading: string
  unsupported: string
}

const LABELS: Record<'ru' | 'en', Labels> = {
  ru: {
    play: 'Воспроизвести', pause: 'Пауза', restart: 'В начало', mute: 'Выключить звук',
    unmute: 'Включить звук', volume: 'Громкость', fullscreen: 'На весь экран',
    exitFullscreen: 'Выйти из полноэкранного режима', loading: 'Загрузка медиа…',
    unsupported: 'Не удалось запустить HTML-плеер'
  },
  en: {
    play: 'Play', pause: 'Pause', restart: 'Restart', mute: 'Mute', unmute: 'Unmute',
    volume: 'Volume', fullscreen: 'Fullscreen', exitFullscreen: 'Exit fullscreen',
    loading: 'Loading media…', unsupported: 'Could not start the HTML player'
  }
}

function projectDuration(project: Project): number {
  let duration = 0
  for (const track of project.tracks) {
    for (const clip of track.clips) duration = Math.max(duration, clip.start + clip.duration)
  }
  return duration
}

function formatTime(value: number): string {
  const seconds = Math.max(0, value)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`HTML player element is missing: ${selector}`)
  return element
}

function renderFailure(root: HTMLElement, labels: Labels, error: unknown): void {
  root.innerHTML = ''
  const message = document.createElement('div')
  message.className = 'kadr-player-error'
  message.textContent = `${labels.unsupported}: ${String(error)}`
  root.appendChild(message)
}

function playerSettings(): HtmlPlayerSettings {
  const data = document.getElementById('kadr-player-settings')
  if (!data) return { ...DEFAULT_HTML_PLAYER_SETTINGS }
  try {
    return { ...DEFAULT_HTML_PLAYER_SETTINGS, ...JSON.parse(data.textContent ?? '{}') }
  } catch {
    return { ...DEFAULT_HTML_PLAYER_SETTINGS }
  }
}

function fragmentAssetPaths(): FragmentAssetRef[] {
  const data = document.getElementById('kadr-fragment-assets')
  if (!data) return []
  try {
    const paths = JSON.parse(data.textContent ?? '[]') as unknown
    return Array.isArray(paths) ? paths.filter((asset): asset is FragmentAssetRef => (
      typeof asset === 'object' && asset !== null && typeof (asset as FragmentAssetRef).path === 'string'
    )) : []
  } catch {
    return []
  }
}

function start(): void {
  const lang = document.documentElement.lang.toLowerCase().startsWith('ru') ? 'ru' : 'en'
  const labels = LABELS[lang]
  const root = document.getElementById('kadr-player')
  const data = document.getElementById('kadr-project')
  if (!root || !data) return

  try {
    const project = JSON.parse(data.textContent ?? '') as Project
    const settings = playerSettings()
    const duration = projectDuration(project)
    const state: PlayerState = { project, playhead: 0, playing: false, loading: false }
    const fileAssets = createFileAssetBridge()
    const preloader = createAssetPreloader(project, fragmentAssetPaths(), fileAssets)

    root.innerHTML = `
      <div class="kadr-stage">
        <div class="kadr-frame">
          <canvas class="kadr-canvas"></canvas>
          <div class="kadr-fragments"></div>
        </div>
        <button class="kadr-big-play" type="button" aria-label="${labels.play}">▶</button>
        <div class="kadr-loading" hidden><span></span>${labels.loading}</div>
      </div>
      <div class="kadr-controls"${!settings.showTimeline && !settings.showControls ? ' hidden' : ''}>
        <button class="kadr-restart" type="button" title="${labels.restart}" aria-label="${labels.restart}">⏮</button>
        <button class="kadr-play" type="button" title="${labels.play}" aria-label="${labels.play}">▶</button>
        <span class="kadr-current">0:00</span>
        <input class="kadr-seek" type="range" min="0" max="${duration}" step="0.001" value="0" aria-label="Timeline" />
        <span class="kadr-duration">${formatTime(duration)}</span>
        <button class="kadr-mute" type="button" title="${labels.mute}" aria-label="${labels.mute}">🔊</button>
        <input class="kadr-volume" type="range" min="0" max="1" step="0.01" value="1" title="${labels.volume}" aria-label="${labels.volume}" />
        <button class="kadr-fullscreen" type="button" title="${labels.fullscreen}" aria-label="${labels.fullscreen}">⛶</button>
      </div>`

    const canvas = required<HTMLCanvasElement>(root, '.kadr-canvas')
    const stage = required<HTMLElement>(root, '.kadr-stage')
    const frameBox = required<HTMLElement>(root, '.kadr-frame')
    const fragments = required<HTMLElement>(root, '.kadr-fragments')
    const playButton = required<HTMLButtonElement>(root, '.kadr-play')
    const bigPlay = required<HTMLButtonElement>(root, '.kadr-big-play')
    const restart = required<HTMLButtonElement>(root, '.kadr-restart')
    const current = required<HTMLElement>(root, '.kadr-current')
    const seek = required<HTMLInputElement>(root, '.kadr-seek')
    const mute = required<HTMLButtonElement>(root, '.kadr-mute')
    const volume = required<HTMLInputElement>(root, '.kadr-volume')
    const fullscreen = required<HTMLButtonElement>(root, '.kadr-fullscreen')
    const loading = required<HTMLElement>(root, '.kadr-loading')
    restart.hidden = !settings.showControls || !settings.allowSeeking
    playButton.hidden = !settings.showControls
    mute.hidden = !settings.showControls
    volume.hidden = !settings.showControls
    fullscreen.hidden = !settings.showControls
    current.hidden = !settings.showTimeline
    seek.hidden = !settings.showTimeline
    required<HTMLElement>(root, '.kadr-duration').hidden = !settings.showTimeline
    if (!settings.allowSeeking) {
      seek.disabled = true
      seek.tabIndex = -1
      seek.setAttribute('aria-readonly', 'true')
      seek.classList.add('read-only')
    }
    canvas.width = project.width
    canvas.height = project.height

    let lastVolume = 1
    let muted = false
    const useWebAudio = location.protocol !== 'file:'
    let fragmentRuntime: FragmentRuntime | null = null
    const updateUi = (): void => {
      playButton.textContent = state.playing ? '⏸' : '▶'
      playButton.title = state.playing ? labels.pause : labels.play
      playButton.ariaLabel = playButton.title
      bigPlay.hidden = state.playing || state.playhead > 0.001
      current.textContent = formatTime(state.playhead)
      seek.value = String(state.playhead)
      loading.hidden = !state.loading
      fragmentRuntime?.update(state.playhead, state.playing, muted ? 0 : lastVolume)
    }

    const player = new Player({
      getState: () => state,
      setPlayhead: (time) => {
        state.playhead = Math.min(duration, Math.max(0, time))
        updateUi()
      },
      setPlaying: (playing) => {
        state.playing = playing
        updateUi()
      },
      setLoading: (isLoading) => {
        state.loading = isLoading
        updateUi()
      },
      duration: () => duration
    }, {
      proxy: false,
      resolveUrl: (path) => fileAssets.resolveUrl(path),
      crossOrigin: false,
      webAudio: useWebAudio,
      outputGain: () => muted ? 0 : lastVolume
    })
    player.attach(canvas)
    fragmentRuntime = createFragmentRuntime(project, fragments)

    const resizeFrame = (): void => {
      const availableWidth = stage.clientWidth
      const availableHeight = stage.clientHeight
      const ratio = project.width / Math.max(1, project.height)
      let width = availableWidth
      let height = width / ratio
      if (height > availableHeight) {
        height = availableHeight
        width = height * ratio
      }
      frameBox.style.width = `${Math.max(1, width)}px`
      frameBox.style.height = `${Math.max(1, height)}px`
    }
    const resizeObserver = new ResizeObserver(resizeFrame)
    resizeObserver.observe(stage)
    resizeFrame()

    const togglePlayback = (): void => {
      if (duration <= 0) return
      if (!state.playing && state.playhead >= duration - 0.001) {
        state.playhead = 0
        preloader.prioritize(0)
      }
      state.playing = !state.playing
      updateUi()
    }
    playButton.addEventListener('click', togglePlayback)
    bigPlay.addEventListener('click', togglePlayback)
    canvas.addEventListener('click', togglePlayback)
    restart.addEventListener('click', () => {
      if (!settings.allowSeeking) return
      state.playhead = 0
      preloader.prioritize(0)
      updateUi()
    })
    seek.addEventListener('input', () => {
      if (!settings.allowSeeking) return
      state.playhead = Number(seek.value)
      preloader.prioritize(state.playhead)
      updateUi()
    })
    volume.addEventListener('input', () => {
      lastVolume = Number(volume.value)
      muted = lastVolume <= 0
      if (useWebAudio) setMasterGain(lastVolume)
      mute.textContent = muted ? '🔇' : '🔊'
      mute.title = muted ? labels.unmute : labels.mute
      mute.ariaLabel = mute.title
      fragmentRuntime?.update(state.playhead, state.playing, muted ? 0 : lastVolume, true)
    })
    mute.addEventListener('click', () => {
      muted = !muted
      if (useWebAudio) setMasterGain(muted ? 0 : lastVolume || 1)
      mute.textContent = muted ? '🔇' : '🔊'
      mute.title = muted ? labels.unmute : labels.mute
      mute.ariaLabel = mute.title
      fragmentRuntime?.update(state.playhead, state.playing, muted ? 0 : lastVolume, true)
    })
    fullscreen.addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen()
      else void root.requestFullscreen()
    })
    document.addEventListener('fullscreenchange', () => {
      const active = Boolean(document.fullscreenElement)
      fullscreen.title = active ? labels.exitFullscreen : labels.fullscreen
      fullscreen.ariaLabel = fullscreen.title
    })
    window.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLInputElement) return
      if (event.code === 'Space') {
        event.preventDefault()
        togglePlayback()
      } else if (settings.allowSeeking && event.code === 'ArrowLeft') {
        state.playhead = Math.max(0, state.playhead - (event.shiftKey ? 10 : 5))
        preloader.prioritize(state.playhead)
        updateUi()
      } else if (settings.allowSeeking && event.code === 'ArrowRight') {
        state.playhead = Math.min(duration, state.playhead + (event.shiftKey ? 10 : 5))
        preloader.prioritize(state.playhead)
        updateUi()
      } else if (settings.allowSeeking && event.code === 'Home') {
        state.playhead = 0
        preloader.prioritize(0)
        updateUi()
      } else if (settings.allowSeeking && event.code === 'End') {
        state.playhead = duration
        preloader.prioritize(duration)
        updateUi()
      } else if (event.code === 'KeyF') {
        fullscreen.click()
      }
    })
    window.addEventListener('beforeunload', () => {
      resizeObserver.disconnect()
      preloader.destroy()
      fileAssets.destroy()
      fragmentRuntime?.destroy()
      player.detach()
    }, { once: true })
    stage.addEventListener('dblclick', () => fullscreen.click())
    updateUi()
  } catch (error) {
    renderFailure(root, labels, error)
  }
}

start()
