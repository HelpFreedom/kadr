# Звуки и музыка, встроенные в Kadr / Bundled sounds and music

Все файлы здесь взяты из навыка /brag
([latent-spaces/brag](https://github.com/latent-spaces/brag), MIT) и лицензированы
их авторами так, что их можно распространять вместе с программой. Лицензии
проверены на страницах первоисточников.

Everything here comes from the /brag skill
([latent-spaces/brag](https://github.com/latent-spaces/brag), MIT) and is licensed by
its authors for redistribution. Each licence was checked at the original source.

## Звуковые эффекты / Sound effects — `sfx/`

| Папка | Источник | Лицензия |
|---|---|---|
| `impact/` | [Kenney — Impact Sounds](https://kenney.nl/assets/impact-sounds) | CC0 1.0 |
| `casino/` | [Kenney — Casino Audio](https://kenney.nl/assets/casino-audio) | CC0 1.0 |
| `interface/` | [Kenney — Interface Sounds](https://kenney.nl/assets/interface-sounds) | CC0 1.0 |
| `ui/` | [Kenney — UI Audio](https://kenney.nl/assets/ui-audio) | CC0 1.0 |
| `keyboard/` | [unicaegames — Keyboard Soundpack #1](https://opengameart.org/content/keyboard-soundpack-1-typing-and-single-keystrokes) | CC0 1.0 |

CC0 — общественное достояние: без условий, указание авторства не обязательно
(но мы его указываем). / Public domain dedication: no conditions.

`sfx-analysis.json` — разбор каждого звука (яркость, «риск резкости», форма
огибающей, для чего подходит) из /brag, © 2026 Shunit Haviv Hakimi, MIT.
The per-sound analysis from /brag, © 2026 Shunit Haviv Hakimi, MIT licence.

## Музыка / Music — `music/`

«Happy Beats / Business Moves» vol. 1, 9, 10, 11, 12 — [ende.app](https://ende.app/en),
лицензия [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
([условия автора](https://ende.app/en/standard-license)). Разрешено в том числе
коммерческое использование: в видео, стримах, подкастах, играх. Автор просит две
вещи: **не выкладывать треки без изменений как свою музыку** на Spotify, Apple Music
и подобные сервисы и **никогда не регистрировать их в YouTube Content ID** и
похожих системах.

Licensed CC BY 4.0 by ende.app. Commercial use in videos, streams, podcasts and
games is allowed. The author asks two things: do not upload the tracks unchanged
as your own music to streaming services, and never register them with YouTube
Content ID or similar systems.

`music/cues/*.music-cues.json` — метки битов, посчитанные librosa 0.11 для /brag
(MIT). Kadr их не читает при работе: это эталон для `node scripts/check-beats.mjs
resources/music`, который проверяет, что наш анализ битов совпадает с librosa.
Beat cues computed by librosa for /brag (MIT); Kadr uses them only as the
reference for its beat-analysis check.
