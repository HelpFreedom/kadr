# Заметки по обновлению библиотек и известным ограничениям

## Адаптация к новым версиям

При обновлении ключевых зависимостей (Electron, React, Chromium, TypeScript) всегда проверяйте:

1. **Удалённые и изменённые API:** Смотрите предупреждения об устаревании и changelog'и. Примеры:
   - Electron 42 удалил `webContents.on('crashed')` — заменён на `'render-process-gone'`.
   - Старые версии Chromium позволяли использовать `<video>` на протоколе `kadr://` без заголовка `Content-Type`; Electron 42+ требует его для выбора декодера.

2. **Новые требования к привилегиям:** Пользовательские URL-схемы часто требуют новых флагов в `protocol.registerSchemesAsPrivileged()`:
   - `standard: true` — включает host-based URL'ы и потоковые Range-запросы
   - `corsEnabled: true` — разрешает кросс-origin запросы (например, dev-сервер `http://localhost` → `kadr://media`)
   - Документируйте, почему нужна каждая привилегия; примеры смотрите в `electron/main.ts`.

3. **Тестируйте полностью:** Всегда запускайте полный e2e-тест после обновлений:
   ```bash
   npm run typecheck
   npm run dev -- --remote-debugging-port=9777 &
   node scripts/e2e.mjs
   ```

## SwiftShader и программный GL: ограничения upstream

**Статус:** SwiftShader (программный WebGL2 fallback в Electron) **не умеет компонать декодированные видеокадры**. Это фундаментальное ограничение Chromium, а не ошибка в Kadr.

### Суть проблемы

Когда элемент `<video>` декодирует под SwiftShader, пайплайн обработки кадра (`HTMLVideoElement` → `VideoDecoder` → GPU-процесс) пытается обернуть кадр в **platform GpuMemoryBuffer SharedImage** через `MailboxVideoFrameConverter`. У SwiftShader нет фабрики для platform-GMB формата (`BGRA_8888, gmb_type: platform`), поэтому:

```
ERROR: Could not find SharedImageBackingFactory with params: 
  usage: Gles2Read|RasterRead|DisplayRead, format: BGRA_8888, 
  gmb_type: platform, size: 1280x720, debug_label: MailboxVideoFrameConverter
ERROR: GPU process crashed / Context was lost
```

Это случается **до** нашего вызова `texImage2D` — workaround с 2D-canvas в компоновщике это не спасает.

### Почему не исправить в приложении?

Краш происходит в ядре пайплайна Chromium. Возможные облегчения и почему они не работают:

- **`--disable-gpu-memory-buffer-video-frames`** — Не влияет на zero-copy путь видео→GPU, который декодер использует до нашего кода.
- **Canvas 2D blit fallback в компоновщике** — Краш происходит до того, как кадры достигнут нашей загрузки в текстуру; blitting краш-нувшегося кадра ничего не решает.
- **Режим программного H.264-декодера** — Выбор видеокодека и аппаратное ускорение в Chromium тесно связаны; переключение кодеков без GPU-поддержки не представлено для embedder'ов.

### Workaround для CI

Headless CI (без сервера дисплея), которому нужно тестировать видео-превью, должна предоставить **реальный или виртуальный GPU**:

```bash
# Вариант 1: xvfb-run с реальным Mesa OpenGL
xvfb-run -a npm run dev -- --remote-debugging-port=9777 &
xvfb-run -a node scripts/e2e.mjs

# Вариант 2: Docker с pass-through GPU (NVIDIA/AMD)
docker run --gpus all ...

# Вариант 3: Wayland/X11 в GitHub Actions с virgl (эмуляция GPU)
# (смотрите документацию runner'а вашего CI-провайдера)
```

**Не** полагайтесь на `KADR_SOFTWARE_GL=1` для видео-тестов; видео-превью будет чёрным и тест упадёт.

### Ссылки на источники

- **Документация Chromium по SwiftShader:** [Using Chromium with SwiftShader](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/gpu/swiftshader.md) — SwiftShader разработан для графических API (WebGL, WebGPU), не для видео-декода. В документации видео-воспроизведение не рассматривается.
- **Upstream-баг:** [qutebrowser#8908 — MailboxVideoFrameConverter crash under SwiftShader](https://github.com/qutebrowser/qutebrowser/issues/8908) — Открыт с марта 2026 года без upstream-фикса. Тот же краш, workaround не найден.

### Текущая конфигурация (Electron 42)

В `electron/main.ts`:

```typescript
const headless = !process.env.WAYLAND_DISPLAY && !process.env.DISPLAY
if (process.env.KADR_SOFTWARE_GL || headless) {
  // SwiftShader: только при явном запросе или в условиях headless
  app.commandLine.appendSwitch('use-gl', 'angle')
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
}
// Иначе используется реальный GPU (NVIDIA, Intel, AMD и т.д.)
```

На машинах с сервером дисплея (Wayland, X11) всегда используется реальный GPU, избегая ограничения программного GL для видео.

## Ключевые файлы

- `electron/main.ts` — обработчик протокола, конфиг GPU, настройка привилегий
- `CLAUDE.md` — требование использовать context7 MCP и консультироваться с актуальной документацией библиотек
