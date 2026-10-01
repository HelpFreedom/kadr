// One speed rule for a clip's audio, shared by the preview and every mixdown.
// Clip speed goes 0.02–100×, but the preview can only play [1/16, 16]×
// (Chromium throws outside it) — so that is the range where audio follows the
// speed exactly: `playbackRate` in the preview, an atempo chain in the export.
// Outside it the clip is SILENT in both. Audio at 50× is noise anyway, and
// silence is exact, where any clamp leaves the sound ending in the wrong place.

export const AUDIO_SPEED_MIN = 1 / 16
export const AUDIO_SPEED_MAX = 16

export function audioFollowsSpeed(speed: number): boolean {
  return speed >= AUDIO_SPEED_MIN - 1e-9 && speed <= AUDIO_SPEED_MAX + 1e-9
}
