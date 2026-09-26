/**
 * The export's master stage: a brick-wall peak limiter on the summed mix.
 *
 * Why it exists: the mix is a plain float sum (amix + volume=N) and nothing
 * stopped it from going over full scale — the encoder then hard-clipped it.
 * A loud master (phonk, EDM, anything mastered to 0 dBFS) under a single 808
 * hit measured +9.8 dBFS in a real project, i.e. audible crackle on
 * exactly the hits that matter.
 *
 * ffmpeg 4.3's alimiter, measured here:
 *  - it holds peaks at `limit` exactly (a 1.8 click came out at the limit);
 *  - below the limit it is transparent — gain 1, bit for bit;
 *  - it DELAYS the signal by its look-ahead: 239 samples at 48 kHz with the
 *    5 ms attack (not 240: at 240 the residual is 0.06, at 239 it is 0.0);
 *  - it does not flush that look-ahead at the end of the stream, so the last
 *    239 samples never come out.
 * Hence the chain: pad 239 samples of silence in front of it, limit, drop the
 * first 239 samples. Result, checked on pink noise below the limit: the same
 * length and bit-identical to the input (scripts/check-limiter.mjs). An export
 * that never reaches the limit is therefore unchanged by this stage.
 *
 * The mix is 48 kHz by construction (segmentChain's aformat), which is what the
 * sample counts assume. Auto-levelling is off (`level=disabled`): this is a
 * safety limiter, not a loudness maximiser.
 */
/**
 * −1 dBFS: the same −1 dBTP ceiling normalizeClip aims for. 0.95 was tried
 * first and a real MP3 export of a limited mix still decoded at −0.1 dB — the
 * codec's reconstruction adds overshoot on top of whatever the mix peaks at,
 * so the limit has to leave room for it.
 */
export const MASTER_LIMIT = 0.891
export const MASTER_SR = 48000
const LOOKAHEAD_SAMPLES = 239

export function masterLimiterChain(): string[] {
  return [
    `apad=pad_len=${LOOKAHEAD_SAMPLES}`,
    `alimiter=limit=${MASTER_LIMIT}:attack=5:release=50:level=disabled`,
    `atrim=start_sample=${LOOKAHEAD_SAMPLES}`,
    'asetpts=N/SR/TB'
  ]
}
