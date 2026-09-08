// Уборка промежуточных версий озвучки.
//
// Каждая перегенерация фразы пишет НОВЫЙ файл и намеренно не трогает
// предыдущий: дубль может не понравиться, и вернуться должно быть куда. Но
// удалять их не умел никто — за один рабочий день у пользователя накопилось
// 4.3 ГБ таких файлов.
//
// Что именно удалять, решает MAIN. Отсюда уходит только список файлов, которые
// проекту НУЖНЫ; назвать файл на удаление рендерер не может в принципе — это и
// есть страховка от того, чтобы скрипт или ошибка в UI снесли чужое.
import { useEditor } from '@/state/store'
import type { VoiceVersionsResult } from '@shared/types'

/** Пути всех ассетов проекта: ни один из них удалён не будет. */
function keepList(): string[] {
  const seen = new Set<string>()
  for (const a of useEditor.getState().project.assets) {
    if (a.path) seen.add(a.path)
  }
  return [...seen]
}

/** Сколько промежуточных версий лежит на диске и сколько они занимают. */
export function scanVoiceVersions(): Promise<VoiceVersionsResult> {
  return window.kadr.voiceVersions({ keep: keepList() })
}

/**
 * Удалить их. Действие НЕОБРАТИМО — отмены у файловой системы нет, поэтому
 * вызывать только после явного подтверждения со списком.
 */
export function pruneVoiceVersions(): Promise<VoiceVersionsResult> {
  return window.kadr.voiceVersions({ keep: keepList(), apply: true })
}
