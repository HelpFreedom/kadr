## Debian vs Arch — важный момент

**Версия Electron в Kadr не зависит от дистрибутива.** При `npm install` всегда скачивается **`electron@31.7.7` из npm** — и на Debian, и на Arch, и на Fedora. Системный пакет `electron` (если он вообще установлен) приложение не использует.

| Что | Откуда берётся |
|---|---|
| Electron в Kadr | `package.json` → npm registry |
| Node.js | Нужен ≥ 20 (часто через nvm/fnm, не из репозитория) |
| ffmpeg/ffprobe | Системные, из PATH |
| python3 + faster-whisper | Системные / pip |

На Arch у вас, скорее всего, новее системные `ffmpeg`, `python`, `node` — но **Electron внутри Kadr всё равно 31.7.7**. У автора на Debian ситуация та же: устаревший не «дебианский Electron», а **зафиксированная в проекте версия**.

---

## Почему на свежем репо (12 июня 2026) такой старый Electron?

Репозиторию ~4 дня, всего **2 коммита** — похоже на первый публичный релиз уже готового проекта, а не на разработку «с нуля за 3 дня».

Вероятные причины выбора Electron 31:

1. **Замороженный стек** — проект мог писаться месяцами; Electron 31 когда-то был актуальным (Chromium 126, ~лето 2024), перед публикацией зависимости не обновили.
2. **Страх сломать ядро** — WebCodecs, GPU-композитинг, VAAPI-флаги в `main.ts`, native `node-pty` — апгрейд на 11 major рискован без полного прогона 26 e2e-тестов.
3. **Парный стек** — `electron-vite@2.3.0` + Remotion 4.0.247 в `~/kadr-fragments` — всё из одной эпохи.
4. **AI-assisted разработка** — в contributors указан «Claude (Anthropic)»; шаблоны/примеры могли быть с Electron 31.
5. **«Работает — не трогай»** — перед релизом приоритет был на фичах, не на dependency refresh.

Маловероятно, что автор специально выбрал старый Electron из-за Debian — скорее **не обновил перед публикацией**.

---



```markdown
## Контекст

При аудите зависимостей перед запуском обнаружил, что проект использует
`electron@31.7.7` (Chromium 126, Node 20.18.0).

По данным [официальных релизов Electron](https://releases.electronjs.org/release/v31.7.7),
ветка **31.x достигла end-of-support** и больше не получает security-патчи.

Актуальный stable на июнь 2026: **electron@42.4.0** (Chromium 148, Node 24.16.0).

## Результаты `npm audit`

`npm audit` помечает `electron <= 39.8.4` как уязвимый. Для 31.7.7 среди
прочего указаны:

| CVE / advisory | Кратко |
|---|---|
| [GHSA-xj5x-m3f3-5x3h](https://github.com/advisories/GHSA-xj5x-m3f3-5x3h) | Service worker может подменять ответы `executeJavaScript` |
| [GHSA-532v-xpq5-8h95](https://github.com/advisories/GHSA-532v-xpq5-8h95) | UAF в paint callback offscreen-окна |
| [GHSA-4p4r-m79c-wq3v](https://github.com/advisories/GHSA-4p4r-m79c-wq3v) | Header injection в custom protocol handlers |
| [GHSA-vmqv-hx8q-j7mg](https://github.com/advisories/GHSA-vmqv-hx8q-j7mg) | ASAR integrity bypass |

Дополнительно (не runtime приложения, но при установке/разработке):
- **esbuild / vite** — уязвимости dev-сервера (`npm run dev`)
- **tar** (через `@electron/rebuild`) — при `npm install`

## Замечания по коду (не обвинение, а контекст)

Часть advisory затрагивает API, которые Kadr использует легитимно:
- `executeJavaScript` — AI-мост Claude (`electron/claude.ts`)
- `protocol.handle('kadr', …)` — стриминг локальных медиа
- offscreen `BrowserWindow` — pixel capture для Remotion-фрагментов

При аудите исходников **признаков злонамеренной эксплуатации CVE не нашёл** —
скорее отставание зависимостей, а не закладка. Но на EOL-версии известные
дыры остаются незакрытыми.

## Предлагаемый путь обновления

Полный скачок 31 → 42 — breaking change (Node 20→24, Chromium 126→148,
пересборка `node-pty`, возможные изменения WebCodecs/GPU). Предлагаю поэтапно:

1. **Минимум:** `electron@39.8.6+` — закрывает большинство CVE из audit
2. Обновить `@electron/rebuild` (audit предлагает 4.x)
3. Проверить совместимость `electron-vite@2.3.0` или поднять до актуальной ветки
4. Прогнать e2e (`scripts/e2e*.mjs`) — особенно экспорт, WebCodecs, MCP-мост, фрагменты
5. **Цель:** `electron@42.x` + актуальный `electron-vite`

## Вопрос к мейнтейнеру

Была ли причина зафиксировать Electron 31 (совместимость WebCodecs/VAAPI,
node-pty, Remotion workspace)? Если да — можно ли задокументировать в README
или завести tracking issue на апгрейд?

Готов помочь с PR (draft), если нужна помощь с миграцией и прогоном тестов
на Linux.

---

**Окружение проверки:**
- ОС: Arch Linux
- Node.js: ≥ 20
- `npm audit` от 2026-06-16
```

---

## Issue или PR?

Для такого репо (2 коммита, свежий релиз) **issue — правильный первый шаг**:

- автор может объяснить, зачем зафиксирован Electron 31;
- апгрейд 31→42 без его CI/e2e легко что-то сломает;
- issue с планом и предложением помочь выглядит конструктивно, а не как «придираетесь».

PR имеет смысл **после** issue или как **Draft PR** со ссылкой на issue — если готовы сами прогнать хотя бы `npm run typecheck` и несколько e2e.

---

**Краткий ответ на ваш вопрос про Debian:** нет, на Debian Electron в Kadr не «новее» и не «старее» — он такой же 31.7.7 из npm. Свежесть репозитория (3 дня) не объясняет выбор версии: скорее проект публиковали с уже замороженным стеком, а не подбирали зависимости под дистрибутив.