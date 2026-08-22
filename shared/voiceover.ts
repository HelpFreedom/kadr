import type { VoiceoverCustomVoice, VoiceoverSettings } from './types'

export interface VoiceoverVoice {
  id: string
  number: number
  name: string
  nameEn: string
  description: string
  descriptionEn: string
  referenceFile: string
}

export interface VoiceoverVoiceChoice {
  id: string
  number?: number
  name: string
  nameEn: string
  description: string
  descriptionEn: string
  customVoice?: VoiceoverCustomVoice
}

export function customVoiceChoice(voice: VoiceoverCustomVoice): VoiceoverVoiceChoice {
  return {
    id: voice.id,
    name: voice.name,
    nameEn: voice.name,
    description: voice.description || 'Пользовательский голосовой клон.',
    descriptionEn: voice.description || 'Custom voice clone.',
    customVoice: voice
  }
}

export function mergeVoiceChoices(custom: VoiceoverCustomVoice[]): VoiceoverVoiceChoice[] {
  const unique = new Map<string, VoiceoverCustomVoice>()
  for (const voice of custom) unique.set(voice.id, voice)
  return [...VOICEOVER_VOICES, ...[...unique.values()].map(customVoiceChoice)]
}

export const VOICEOVER_REFERENCE_TEXT =
  'Д+обрый д+ень. Сег+одня начин+ается интер+есная игр+а. Сл+ушайте вним+ательно.'

/** VoiceDesign references approved for the F5-TTS voice selector.
 * Original variants 5, 6 and 11 are deliberately excluded. */
export const VOICEOVER_VOICES: readonly VoiceoverVoice[] = [
  {
    id: '01_female_quiz_host_bright', number: 1,
    name: 'Яркая ведущая квиза', nameEn: 'Bright quiz host',
    description: 'Энергичная, улыбчивая, с чёткой студийной дикцией.',
    descriptionEn: 'Energetic and smiling, with clear studio diction.',
    referenceFile: '01_female_quiz_host_bright.wav'
  },
  {
    id: '02_female_host_warm', number: 2,
    name: 'Тёплая ведущая', nameEn: 'Warm host',
    description: 'Спокойная, интеллигентная, мягкий насыщенный тембр.',
    descriptionEn: 'Calm and intelligent, with a soft, rich timbre.',
    referenceFile: '02_female_host_warm.wav'
  },
  {
    id: '03_male_quiz_host_confident', number: 3,
    name: 'Уверенный мужской ведущий', nameEn: 'Confident male host',
    description: 'Дружелюбный баритон и энергичная телевизионная подача.',
    descriptionEn: 'A friendly baritone with energetic television delivery.',
    referenceFile: '03_male_quiz_host_confident.wav'
  },
  {
    id: '04_male_deep_cinematic', number: 4,
    name: 'Глубокий кинематографичный', nameEn: 'Deep cinematic male',
    description: 'Низкий резонансный голос, размеренный и авторитетный.',
    descriptionEn: 'A low resonant voice, measured and authoritative.',
    referenceFile: '04_male_deep_cinematic.wav'
  },
  {
    id: '07_teen_girl_energetic', number: 7,
    name: 'Энергичная девушка-подросток', nameEn: 'Energetic teenage girl',
    description: 'Свежий молодой голос, дружелюбный и современный.',
    descriptionEn: 'A fresh, youthful voice with friendly modern delivery.',
    referenceFile: '07_teen_girl_energetic.wav'
  },
  {
    id: '08_teen_boy_friendly', number: 8,
    name: 'Дружелюбный парень-подросток', nameEn: 'Friendly teenage boy',
    description: 'Лёгкий молодой голос с естественным разговорным ритмом.',
    descriptionEn: 'A light youthful voice with a natural conversational rhythm.',
    referenceFile: '08_teen_boy_friendly.wav'
  },
  {
    id: '09_elderly_woman_storyteller', number: 9,
    name: 'Пожилая рассказчица', nameEn: 'Elderly woman storyteller',
    description: 'Добрый, тёплый голос с лёгкой хрипотцой.',
    descriptionEn: 'A kind, warm voice with a gentle rasp.',
    referenceFile: '09_elderly_woman_storyteller.wav'
  },
  {
    id: '10_elderly_man_storyteller', number: 10,
    name: 'Пожилой рассказчик', nameEn: 'Elderly man storyteller',
    description: 'Низкий шероховатый тембр и неторопливая мудрая подача.',
    descriptionEn: 'A low, slightly rough timbre with deliberate delivery.',
    referenceFile: '10_elderly_man_storyteller.wav'
  },
  {
    id: '12_cartoon_villain', number: 12,
    name: 'Мультяшный злодей', nameEn: 'Cartoon villain',
    description: 'Очень низкий театральный голос, озорной, а не пугающий.',
    descriptionEn: 'A very low theatrical voice, mischievous rather than scary.',
    referenceFile: '12_cartoon_villain.wav'
  },
  {
    id: '13_sports_commentator', number: 13,
    name: 'Спортивный комментатор', nameEn: 'Sports commentator',
    description: 'Быстрый, динамичный и эмоциональный эфирный голос.',
    descriptionEn: 'Fast, dynamic and excited broadcast delivery.',
    referenceFile: '13_sports_commentator.wav'
  },
  {
    id: '14_mysterious_female', number: 14,
    name: 'Таинственный женский', nameEn: 'Mysterious female',
    description: 'Мягкий тёмный тембр, сдержанная близкая подача.',
    descriptionEn: 'A soft, dark timbre with restrained intimate delivery.',
    referenceFile: '14_mysterious_female.wav'
  }
] as const

export const DEFAULT_VOICEOVER_SETTINGS: VoiceoverSettings = {
  modelPath: '',
  pythonPath: '',
  vocabPath: '',
  voicesPath: '',
  voiceId: VOICEOVER_VOICES[0].id,
  speed: 1,
  nfeStep: 24,
  cfgStrength: 2,
  swaySamplingCoef: -1,
  crossFadeDuration: 0.12,
  seed: 20260816,
  loudnessLufs: -16,
  truePeakDb: -1.5
}

export function getVoiceoverVoice(id: string | undefined): VoiceoverVoice {
  return VOICEOVER_VOICES.find((voice) => voice.id === id) ?? VOICEOVER_VOICES[0]
}

export function normalizeVoiceoverSettings(
  settings?: Partial<VoiceoverSettings> | null
): VoiceoverSettings {
  const merged = { ...DEFAULT_VOICEOVER_SETTINGS, ...settings }
  const voiceId = merged.customVoice?.id === merged.voiceId
    ? merged.voiceId
    : getVoiceoverVoice(merged.voiceId).id
  return { ...merged, voiceId }
}
