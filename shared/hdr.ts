// HDR → SDR maths (the LUT behind electron/hdr.ts), kept free of node and
// electron so `node scripts/check-hdr.mjs` can test it against ffmpeg.
//
// ffmpeg 4.3 on this machine has no zscale (the usual tonemap route), so the
// conversion is a 3D LUT computed here, in closed form, and applied with
// lut3d between two swscale matrix conversions:
//   Y'CbCr (BT.2020, limited) → R'G'B' (full) → LUT → R'G'B' BT.709 → Y'CbCr BT.709 (limited)
// The LUT does, per colour: the transfer's inverse (HLG inverse OETF + its
// OOTF at 1000 nits / γ 1.2, or the PQ EOTF), scaling so reference white
// (203 nits — HLG 75 %) lands near SDR white, a shoulder above it that keeps
// highlights apart up to a 1000-nit peak instead of clipping them (applied to
// the brightest channel, so hue holds), BT.2020 → BT.709 primaries with
// out-of-gamut colours pulled towards their own luminance rather than clipped
// per channel — a straight line to grey keeps the dominant wavelength, i.e.
// the hue — and the BT.709 OETF.

export type HdrKind = 'hlg' | 'pq'

/** the conversion's generation: goes into the LUT file name and every cache
    key of a tone-mapped file, so a change of the curve rebuilds them all
    (2: the extended-Reinhard shoulder) */
export const HDR_VERSION = 2

export const hdrOfTransfer = (trc: string | undefined): HdrKind | null =>
  trc === 'arib-std-b67' ? 'hlg' : trc === 'smpte2084' ? 'pq' : null

// ---------------------------------------------------------------- the maths

const HLG_A = 0.17883277, HLG_B = 1 - 4 * 0.17883277, HLG_C = 0.5 - 0.17883277 * Math.log(4 * 0.17883277)

/** HLG signal → scene light, 0..1 (BT.2100 inverse OETF) */
const hlgInvOetf = (e: number) => (e <= 0.5 ? (e * e) / 3 : (Math.exp((e - HLG_C) / HLG_A) + HLG_B) / 12)

/** PQ signal → display light, nits (BT.2100 EOTF) */
const pqEotf = (e: number) => {
  const m1 = 2610 / 16384, m2 = (2523 / 4096) * 128, c1 = 3424 / 4096, c2 = (2413 / 4096) * 32, c3 = (2392 / 4096) * 32
  const p = Math.pow(Math.max(0, e), 1 / m2)
  return 10000 * Math.pow(Math.max(0, p - c1) / (c2 - c3 * p), 1 / m1)
}

/** BT.2020 → BT.709 primaries, linear light */
const M2020_709 = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187]
]

const oetf709 = (l: number) => (l < 0.018 ? 4.5 * l : 1.099 * Math.pow(l, 0.45) - 0.099)

/** the brightest light the conversion keeps apart: a 1000-nit master (HLG's
    nominal peak, the usual PQ grade) — 4.93× reference white */
export const HDR_PEAK = 1000 / 203

/**
 * Display-referred linear (1 = SDR reference white) → 0..1: straight up to
 * `k`, then an extended-Reinhard shoulder that meets the line with the same
 * slope and puts HDR_PEAK exactly at 1. The first version rolled off with an
 * exponential of width 1 − k, which reached 0.99 at 1.3× reference white: every
 * highlight of a phone video (the sky, a window, a lamp — up to 4.9×) came out
 * the same flat white. Found by scripts/check-hdr.mjs.
 */
export function shoulder(x: number, k = 0.85, peak = HDR_PEAK): number {
  if (x <= k) return x
  const u = (x - k) / (1 - k)
  const lw = (peak - k) / (1 - k)
  return Math.min(1, k + (1 - k) * (u * (1 + u / (lw * lw))) / (1 + u))
}

/** one LUT entry: R'G'B' (0..1, BT.2020, HDR-encoded) → R'G'B' (0..1, BT.709 SDR) */
export function hdrToSdr(kind: HdrKind, r: number, g: number, b: number): [number, number, number] {
  let R: number, G: number, B: number
  if (kind === 'hlg') {
    // scene light, then the OOTF of a 1000-nit display (γ 1.2 on luminance);
    // HLG reference white (signal 75 %) comes out at 203 nits = SDR white
    const rs = hlgInvOetf(r), gs = hlgInvOetf(g), bs = hlgInvOetf(b)
    const ys = 0.2627 * rs + 0.678 * gs + 0.0593 * bs
    const k = ys > 0 ? Math.pow(ys, 0.2) : 0
    const white = Math.pow(hlgInvOetf(0.75), 1.2) // reference white after the OOTF
    R = (k * rs) / white; G = (k * gs) / white; B = (k * bs) / white
  } else {
    R = pqEotf(r) / 203; G = pqEotf(g) / 203; B = pqEotf(b) / 203
  }
  // gamut: BT.2020 → BT.709; what falls outside is desaturated towards its own luminance
  let o = M2020_709.map((row) => row[0] * R + row[1] * G + row[2] * B)
  const y = 0.2126 * o[0] + 0.7152 * o[1] + 0.0722 * o[2]
  const lo = Math.min(...o)
  if (lo < 0 && y > 0) {
    const t = y / (y - lo) // move towards grey until the lowest channel reaches 0
    o = o.map((c) => y + (c - y) * t)
  }
  // THEN the shoulder, on the brightest channel (a common factor keeps the
  // hue). Before the primaries it was wrong: the matrix pushes a warm BT.2020
  // colour's red past 1 again, and the clip below then turned orange 2.4°
  // towards yellow (found by scripts/check-hdr.mjs).
  const m = Math.max(o[0], o[1], o[2])
  if (m > 0) { const sc = shoulder(m) / m; o = o.map((c) => c * sc) }
  return o.map((c) => oetf709(Math.max(0, Math.min(1, c)))) as [number, number, number]
}

/** The ffmpeg filter chain turning an HDR picture into SDR BT.709 (limited range, yuv420p). */
export function hdrFilter(lutPath: string): string {
  // lut3d's file option is a filter argument: escape what the filter parser treats specially
  const f = lutPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
  return 'scale=in_color_matrix=bt2020:in_range=tv:out_range=pc,format=gbrp16le,' +
    `lut3d=file='${f}':interp=tetrahedral,` +
    'scale=out_color_matrix=bt709:in_range=pc:out_range=tv,format=yuv420p'
}


/** the whole .cube file for a transfer (red changes fastest, as the format wants) */
export function hdrCube(kind: HdrKind, size = 33): string {
  const lines = [`TITLE "Kadr ${kind.toUpperCase()} BT.2020 to SDR BT.709"`, `LUT_3D_SIZE ${size}`]
  const n = size - 1
  for (let bi = 0; bi <= n; bi++) {
    for (let gi = 0; gi <= n; gi++) {
      for (let ri = 0; ri <= n; ri++) {
        const [r, g, b] = hdrToSdr(kind, ri / n, gi / n, bi / n)
        lines.push(`${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`)
      }
    }
  }
  return lines.join('\n') + '\n'
}
