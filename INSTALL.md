# Установка Kadr

## Для пользователя — готовый архив (рекомендуется)

Не нужен ни `npm install`, ни компиляторы, ни системный ffmpeg. Особенно
актуально для immutable-дистрибутивов (Bazzite, Silverblue, Kinoite).

**tar.gz:**
```bash
tar -xzf kadr-<версия>-linux-x64.tar.gz
cd kadr-<версия>-linux-x64
./kadr
```

**AppImage:**
```bash
chmod +x Kadr-<версия>-linux-x86_64.AppImage
./Kadr-<версия>-linux-x86_64.AppImage
# нет FUSE? → ./Kadr-*.AppImage --appimage-extract-and-run
```

Что работает сразу, без доустановки:
- **Ядро** (импорт / превью / экспорт) — встроены статические `ffmpeg`/`ffprobe`.
- **Субтитры** (faster-whisper) — встроен переносимый Python. При первом
  использовании один раз качается ML-модель (нужна сеть).
- **Remotion-фрагменты** — встроены Node и пред-установленные зависимости.
  Если сборка не «прогрела» headless-Chromium, он один раз докачается при
  первом рендере фрагмента (сеть; но уже без системного Node).

Опционально (ставит сам пользователь): **Claude-панель** требует установленного
`claude` CLI в `PATH` — это личный инструмент/аккаунт, встроить его нельзя.

Только `linux-x64` (glibc). Для arm64 / musl нужна отдельная сборка.

### Запуск из меню приложений (без терминала)

**AppImage** — уже запускается двойным кликом из файлового менеджера (нужен бит
«исполняемый»: ПКМ → Свойства → Разрешения). Чтобы появилась постоянная иконка в
меню приложений и автообновление — интегрируй его через **Gearlever** (штатный
GUI-способ для Bazzite/атомарных систем):
```bash
flatpak install flathub it.mijorus.gearlever
```
Открой Gearlever → перетащи в него `Kadr-*.AppImage` → «Add to menu». Дальше Kadr
запускается из меню как обычное приложение.

**tar.gz** — распакуй, положи папку в постоянное место и один раз запусти
`install.sh`:
```bash
tar -xzf kadr-<версия>-linux-x64.tar.gz
sudo mv kadr-<версия>-linux-x64 /opt/kadr     # любое постоянное место
bash /opt/kadr/install.sh                      # БЕЗ sudo — пишет в ~/.local
```
После этого «Kadr» появляется в меню/поиске KDE с логотипом и запускается кликом,
без терминала — и всё (звук, экспорт, субтитры, Remotion, Claude-панель) работает
без ручной настройки. `install.sh` запускай **своим пользователем, не через sudo**
(он пишет только в `~/.local/share`, даже если приложение лежит в `/opt`).
Перенёс папку — запусти `bash /opt/kadr/install.sh` ещё раз. Убрать ярлык:
`bash /opt/kadr/install.sh --uninstall`.

---

## Для мейнтейнера — сборка архива

Сборку нужно делать в окружении с тулчейном (компилятор для `node-pty`), а не на
голом immutable-хосте. Штатный путь — distrobox:

```bash
distrobox create --name kadr-build --image fedora:42
distrobox enter  kadr-build
sudo dnf install -y gcc-c++ make python3 nodejs npm tar xz which curl

cd ~/Projects/kadr
npm run pack            # = bash scripts/pack.sh
```

Артефакты появятся в `dist/`. Скрипт сам:
1. собирает приложение (`npm ci` + `electron-vite build`);
2. кладёт статический ffmpeg/ffprobe, переносимый Node и Python+faster-whisper в
   `runtime/`;
3. пред-устанавливает зависимости Remotion в `kadr-fragments-seed/`;
4. пересобирает `node-pty` под ABI встроенного Electron и пакует
   tar.gz + AppImage через electron-builder.

Флаги `scripts/pack.sh`:
- `--lite` — только ядро + ffmpeg (без whisper и Remotion; ~в разы меньше размер);
- `--model <name>` — предвложить модель субтитров (`base`, `small`, …) для
  полностью офлайн-субтитров;
- `--skip-build` — переиспользовать существующий `out/`.

Версии вложенных Node / Python / ffmpeg закреплены вверху `scripts/pack.sh` —
меняются там. Размер полного архива ориентировочно ~0.5–0.7 ГБ.

> Как это устроено под капотом: `electron/runtime-env.ts` (первый импорт
> `main.ts`) в упакованной сборке добавляет `resources/runtime/bin` в `PATH` и
> выставляет `KADR_FFMPEG`/`KADR_FFPROBE`, поэтому все внешние вызовы
> (`ffmpeg`, `python3`, `npm`, `npx`, `node`) резолвятся во вложенные бинарники.
> Упаковка идёт без asar — `electron/mcp-bridge.cjs` и `scripts/transcribe.py`
> запускаются внешними процессами по реальному пути и внутри asar не читались бы.
