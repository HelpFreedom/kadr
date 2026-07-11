{
  description = "Kadr dev environment (NixOS)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs_22
            pkgs.electron
            pkgs.ffmpeg
            pkgs.gcc
            pkgs.gnumake
            pkgs.python3
            pkgs.pkg-config
          ];

          shellHook = ''
            # --- Force X11/XWayland: native Wayland/Ozone crashes or renders
            # a blank window under some compositors (observed on Niri). ---
            export ELECTRON_OZONE_PLATFORM_HINT=x11
            export XDG_SESSION_TYPE=x11
            unset WAYLAND_DISPLAY
            unset NIRI_SOCKET

            export KADR_FFMPEG="${pkgs.ffmpeg}/bin/ffmpeg"
            export KADR_FFPROBE="${pkgs.ffmpeg}/bin/ffprobe"

            # --- npm's "electron" package expects to download a prebuilt
            # binary into node_modules/electron/dist/, which fails on
            # NixOS's non-FHS filesystem. Point it at the nixpkgs build
            # instead, the same way `electron` upstream supports via
            # path.txt + dist/<name>. ---
            if [ -d node_modules/electron ] && [ ! -f node_modules/electron/dist/electron ]; then
              mkdir -p node_modules/electron/dist
              printf "electron" > node_modules/electron/path.txt
              ln -sf "${pkgs.electron}/bin/electron" node_modules/electron/dist/electron
              echo "[flake] linked node_modules/electron/dist/electron -> nixpkgs electron"
            fi

            echo "[flake] Kadr devShell ready. Run: npm install && npm run dev"
          '';
        };
      });
}
