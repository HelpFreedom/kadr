// ElevenLabs models: which ones the editor offers, what one request may carry,
// and which voice settings each one honours. Shared by main (request building,
// chunking) and the settings dialog (which sliders mean anything).
//
// Checked against the live API on 2026-10-20, not only the docs — the docs
// contradict each other here. The changelog and the model pages say Eleven v4
// is served by the Text to Dialogue API and v4 Turbo only by its WebSocket,
// but the plain POST /v1/text-to-speech/{voice} (and /with-timestamps) answers
// both with audio, and the history item names the model that really ran
// (`model_id: eleven_v4` / `eleven_v4_turbo`, `source: TTS`). The same request
// accepted previous_text/next_text of 400 characters (the Dialogue API refuses
// past 100), previous_request_ids and seed, and returned a per-character
// alignment. So the v4 models ride the existing path; what differs is below.
//
// Cost: `character-cost` came back 3 for three characters on v4 and 2 on
// v4 Turbo — the 1.0 and 0.5 `character_cost_multiplier` of GET /v1/models,
// the same 0.5 as Flash v2.5. Context text is not billed.

export interface TtsModelInfo {
  id: string
  name: string
  /** API price, USD per 1000 characters (elevenlabs.io/pricing/api, 2026-10) */
  usdPer1k?: number
  /** the API's own cap on one request */
  maxChars: number
  /** how much Kadr puts in one request; longer scripts are cut at sentence
      ends and stitched with previous_text/next_text + previous_request_ids */
  chunkChars: number
  /** whether style / use_speaker_boost / speed are sent at all */
  style: boolean
  speakerBoost: boolean
  speed: boolean
}

/**
 * Eleven v4 and v4 Turbo take only Stability and Similarity: no Style, no
 * Speed, no speaker boost (/v1/models: can_use_style and can_use_speaker_boost
 * false; the v4 page: «Style and Speed sliders are not available»). Sent
 * anyway they are dropped without an error — the history keeps the stability
 * alone — so they are left out instead of pretending to do something.
 *
 * A request may hold 10 000 characters, but ElevenLabs' own guidance for this
 * model family is ~2 000 per request — longer ones «can terminate early». A
 * truncated chunk is a silent hole in the voice-over, a seam is stitched with
 * request ids, so v4 is cut at 2 000.
 */
const V4 = { maxChars: 10000, chunkChars: 2000, style: false, speakerBoost: false, speed: false }
/** every setting is sent, as before v4 existed — the older models keep their exact requests */
const ALL = { style: true, speakerBoost: true, speed: true }

/** offered in the settings dialog, best first */
export const TTS_MODELS: TtsModelInfo[] = [
  { id: 'eleven_v4_turbo', name: 'Eleven v4 Turbo', usdPer1k: 0.04, ...V4 },
  { id: 'eleven_v4', name: 'Eleven v4', usdPer1k: 0.08, ...V4 },
  { id: 'eleven_flash_v2_5', name: 'Flash v2.5', usdPer1k: 0.04, maxChars: 40000, chunkChars: 36000, ...ALL },
  { id: 'eleven_multilingual_v2', name: 'Multilingual v2', usdPer1k: 0.08, maxChars: 10000, chunkChars: 9000, ...ALL }
]

/** not offered any more, still served: a voice-over made with one regenerates
    with it (deprecated by ElevenLabs in favour of Flash, or superseded by v4) */
const LEGACY: TtsModelInfo[] = [
  { id: 'eleven_turbo_v2_5', name: 'Turbo v2.5', usdPer1k: 0.04, maxChars: 40000, chunkChars: 36000, ...ALL },
  { id: 'eleven_monolingual_v1', name: 'Monolingual v1', maxChars: 10000, chunkChars: 9000, ...ALL },
  { id: 'eleven_v3', name: 'Eleven v3', usdPer1k: 0.08, maxChars: 3000, chunkChars: 2700, ...ALL }
]

/** any id — an unknown one gets the conservative 10 000 and every setting, as before */
export function ttsModel(id: unknown): TtsModelInfo {
  const key = typeof id === 'string' ? id : ''
  return TTS_MODELS.find((m) => m.id === key) ?? LEGACY.find((m) => m.id === key) ??
    { id: key, name: key || '—', maxChars: 10000, chunkChars: 9000, ...ALL }
}
