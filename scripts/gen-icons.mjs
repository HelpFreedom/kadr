// Regenerate src/components/icons.tsx from the lucide SVG set.
//
//   npm pack lucide-static --pack-destination /tmp
//   tar xzf /tmp/lucide-static-*.tgz -C /tmp        # -> /tmp/package/icons/*.svg
//   node scripts/gen-icons.mjs [/tmp/package]
//
// Add a glyph by adding a line to MAP (kadr name -> lucide file name) and
// running this again; do not hand-edit the paths in icons.tsx.
import { readFileSync, writeFileSync } from 'node:fs'

const PKG = process.argv[2] || '/tmp/package'
const DIR = `${PKG}/icons`

// name in Kadr -> lucide file
const MAP = {
  undo: 'undo-2', redo: 'redo-2',
  toStart: 'skip-back', toEnd: 'skip-forward', play: 'play', pause: 'pause',
  split: 'scissors', trash: 'trash-2', text: 'type', camera: 'camera',
  check: 'check', close: 'x', plus: 'plus', minus: 'minus',
  bot: 'bot', terminal: 'terminal',
  audio: 'audio-lines', music: 'music', spinner: 'loader-circle',
  captions: 'captions', doc: 'file-text', srt: 'clapperboard',
  chevronDown: 'chevron-down', chevronRight: 'chevron-right',
  chevronLeft: 'chevron-left', chevronUp: 'chevron-up',
  first: 'chevron-first', last: 'chevron-last',
  speech: 'speech', mic: 'mic',
  star: 'star', glow: 'sparkles', blur: 'circle-dashed',
  link: 'link', unlink: 'unlink', magnet: 'magnet',
  lock: 'lock', unlock: 'lock-open',
  volume: 'volume-2', mute: 'volume-x',
  move: 'move', wave: 'waves', target: 'target', pencil: 'pencil',
  again: 'rotate-cw', reload: 'rotate-ccw', loop: 'repeat', rewind: 'rewind',
  eye: 'eye', eyeOff: 'eye-off', broom: 'brush-cleaning',
  diamond: 'diamond', diamondMinus: 'diamond-minus',
  square: 'square', circle: 'circle', triangle: 'triangle',
  image: 'image', film: 'film',
  arrowRight: 'arrow-right', download: 'download', save: 'save',
  folderOpen: 'folder-open', filePlus: 'file-plus',
  settings: 'settings-2', crop: 'crop', layers: 'layers', atom: 'atom',
  transition: 'blend', junction: 'git-commit-horizontal',
  gauge: 'gauge', grip: 'grip-vertical', language: 'languages',
  popout: 'picture-in-picture-2', popin: 'picture-in-picture',
  alert: 'triangle-alert',
  beat: 'metronome', sfx: 'bell-ring', reactive: 'activity'
}

const body = (file) => {
  const raw = readFileSync(`${DIR}/${file}.svg`, 'utf8')
  const inner = raw.slice(raw.indexOf('>', raw.indexOf('<svg')) + 1, raw.lastIndexOf('</svg>'))
  return inner
    .split('\n').map((l) => l.trim()).filter(Boolean).join('')
    .replace(/\s*\/>/g, ' />')
}

const names = Object.keys(MAP).sort()
const lines = names.map((n) => `  ${n}: (\n    <>${body(MAP[n])}</>\n  )`)

const out = `// Icon set for the Kadr interface.
//
// Lucide (https://lucide.dev, ISC) drawn inline: no runtime dependency, no
// network, and every glyph inherits currentColor and the size the caller asks
// for. Emoji were used here before and they are not an option in a tool this
// dense: their shape, weight and colour come from whatever font the OS ships,
// so they never line up with the text next to them and never match each other.
//
// Generated from lucide-static ${JSON.parse(readFileSync(`${PKG}/package.json`, 'utf8')).version}; edit the map in scripts, not the paths by hand.
import type { ReactElement } from 'react'

const GLYPHS: Record<string, ReactElement> = {
${lines.join(',\n')}
}

export type IconName = keyof typeof GLYPHS & string

/**
 * One icon. \`size\` is in px and defaults to 16, which sits right next to the
 * 13px UI text; timeline chrome asks for 11-12.
 */
export function Icon({
  name, size = 16, className, strokeWidth = 2, style
}: {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
  style?: React.CSSProperties
}) {
  const glyph = GLYPHS[name]
  if (!glyph) return null
  return (
    <svg
      className={className ? \`ico \${className}\` : 'ico'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      {glyph}
    </svg>
  )
}

/** The spinner: same icon, rotated by CSS (and held still under reduced motion). */
export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Icon name="spinner" size={size} className={className ? \`spin \${className}\` : 'spin'} />
}
`
writeFileSync(new URL('../src/components/icons.tsx', import.meta.url), out)
console.log('icons:', names.length)
