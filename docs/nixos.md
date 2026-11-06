# Running Kadr on NixOS / Запуск Kadr на NixOS

<details open>
<summary><b>English</b></summary>

## Quick start (with flake)

```bash
nix develop
npm install
npm run dev
```

The devShell provides `gcc`/`make`/`python3` (needed to build the native
`node-pty` dependency), `electron`, and `ffmpeg`, and automatically:

- forces X11/XWayland via `ELECTRON_OZONE_PLATFORM_HINT=x11` (native
  Wayland/Ozone can crash or render a blank window depending on your
  compositor),
- links `node_modules/electron/dist/electron` to the nixpkgs Electron
  binary, since the npm `electron` package's binary download doesn't work
  on NixOS's non-FHS filesystem.

## Without the flake

If you don't want to use flakes, run once per shell session:

```bash
nix-shell -p gcc gnumake python3 --run "npm install"

export ELECTRON_OZONE_PLATFORM_HINT=x11
export XDG_SESSION_TYPE=x11
unset WAYLAND_DISPLAY

nix-shell -p electron --run '
  mkdir -p node_modules/electron/dist
  printf "electron" > node_modules/electron/path.txt
  ln -sf $(which electron) node_modules/electron/dist/electron
  npm run dev
'
```

## Known-good config

These fixes live in the app code (not NixOS-specific), but are worth
knowing about if you hit similar symptoms elsewhere:

- `electron.vite.config.ts` pins the renderer dev server to
  `host: '127.0.0.1'` to avoid an intermittent `ERR_NETWORK_CHANGED` on
  systems with IPv6 disabled or misconfigured.
- `electron/preload.ts` assigns `window.kadr` unconditionally (guarded by
  `Object.keys(api)`) so Vite's bundler can't tree-shake the whole API
  object away when `contextIsolation: false` is a compile-time constant.

</details>

<details>
<summary><b>Русский</b></summary>

## Быстрый старт (с флейком)

```bash
nix develop
npm install
npm run dev
```

DevShell предоставляет `gcc`/`make`/`python3` (нужны для сборки нативной
зависимости `node-pty`), `electron` и `ffmpeg`, а также автоматически:

- принудительно включает X11/XWayland через `ELECTRON_OZONE_PLATFORM_HINT=x11`
  (нативный Wayland/Ozone может падать или рисовать пустое окно в
  зависимости от вашего компоузера),
- линкует `node_modules/electron/dist/electron` на бинарник Electron из
  nixpkgs, так как загрузка бинарника npm-пакетом `electron` не работает
  на не-FHS файловой системе NixOS.

## Без флейка

Если не хотите использовать флейки, выполняйте один раз на сессию шелла:

```bash
nix-shell -p gcc gnumake python3 --run "npm install"

export ELECTRON_OZONE_PLATFORM_HINT=x11
export XDG_SESSION_TYPE=x11
unset WAYLAND_DISPLAY

nix-shell -p electron --run '
  mkdir -p node_modules/electron/dist
  printf "electron" > node_modules/electron/path.txt
  ln -sf $(which electron) node_modules/electron/dist/electron
  npm run dev
'
```

## Известные фиксы в конфиге

Эти фиксы находятся в коде приложения (не специфичны для NixOS), но
полезно о них знать при похожих симптомах в других окружениях:

- `electron.vite.config.ts` закрепляет dev-сервер рендерера на
  `host: '127.0.0.1'`, что убирает периодический `ERR_NETWORK_CHANGED` на
  системах с отключённым или неправильно настроенным IPv6.
- `electron/preload.ts` присваивает `window.kadr` безусловно (под защитой
  `Object.keys(api)`), чтобы бандлер Vite не мог вытряхнуть весь объект
  API tree-shaking'ом, когда `contextIsolation: false` известна на этапе
  компиляции.

</details>
