# Desktop builds

Notefira uses Tauri 2 and the same `dist/` frontend as the PWA.

1. Install the current stable Rust toolchain and the Tauri prerequisites for the target operating system.
2. Run `npm ci`, then `npm run desktop:build` from `app/`.
3. Installers are written beneath `src-tauri/target/release/bundle/`.

Build on each target OS: NSIS/MSI on Windows, DMG/app bundle on macOS, and AppImage/deb on Linux. Code signing and updater publishing credentials must be supplied by the distributor and must never be committed. Google sign-in also requires a Google OAuth client configured for the packaged app.
