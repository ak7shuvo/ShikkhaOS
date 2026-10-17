# Desktop application (Phase 4A foundation)

One shared codebase, school-branded builds. The desktop app is an **Electron shell around the unchanged web UI** (`web/`) and the unchanged API contract. Business logic stays on the server; nothing is duplicated.

Status: **foundation only.** A Linux x64 AppImage and tar.gz can be built and were launch-tested headlessly (Xvfb). Not done: Windows, Android, signing, auto-update, offline, Google Drive backup (see [Roadmap](#roadmap)). Platform-admin MFA is separate, outstanding security work ([PHASE3_SECURITY_REVIEW.md](security/PHASE3_SECURITY_REVIEW.md)); the platform is **not** production-ready because of this, and the desktop client does not expose any platform-administration function.

## Architecture decision

| Option                              | Verdict                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Electron** (chosen)               | Same JS/TS monorepo and toolchain, one Chromium everywhere (predictable CSP/cookie/`fetch` behaviour), builds Linux now and Windows next from the same config, CI runners already have what it needs. Cost: ~120 MB artifacts. |
| Tauri                               | Smaller binaries, but needs a Rust toolchain and per-OS WebView differences (WebKitGTK on Linux vs WebView2 on Windows); the existing docs mention it only as a possibility. Revisit if size matters.                          |
| Loading the hosted site in a window | Works with cookies unchanged, but ships no UI, depends on the network for the UI itself, and trusts a remote origin with the app's privileges. Rejected.                                                                       |
| Capacitor                           | Android only; planned for the APK, reusing `web/dist` the same way.                                                                                                                                                            |

### The session problem and how it is solved without changing the API

The API uses a `SameSite=Strict` cookie and rejects state-changing requests whose `Origin` is not allow-listed ([SECURITY.md](SECURITY.md)). A page served from a custom scheme calling a remote API is cross-site, so the cookie would not be sent. Instead of weakening that (token mode / `SameSite=None` / extra allowed origins), the **main process is the HTTP client**:

```
renderer (sandboxed)            main process                         API (unchanged)
app://shikkha/…  ── fetch /api/x ──▶  allow-list + cookie jar ──▶  https://api.school.example/api/x
                                       (sid kept in memory,         (cookie, CSRF origin rule and
                                        never given to the page)     authorization all as for browsers)
```

- The web build keeps relative `/api/...` calls (no `VITE_API_BASE_URL`). `app://shikkha/api/*` is handled in `src/main.ts` → `src/api-proxy.ts`.
- The proxy forwards only `GET/POST/PUT/PATCH`, only to the single configured API origin, only paths under `/api/` after normalisation, and **never** `/api/platform/*` (Petra staff API) in any encoding. It drops the page's `Cookie`/`Origin`/other headers, keeps only the school session cookie `sid` in an in-memory jar, strips `Set-Cookie` from responses, refuses redirects, caps bodies at 1 MB, and returns a generic 502 without connection details when the API is unreachable.
- Because the session lives only in the main process memory, a user signs in again after restarting the app. Persistent sessions (OS keychain via `safeStorage`) are a later decision.
- Tenant isolation and authorization are untouched: they are enforced by the API per request exactly as for the browser; the desktop build is locked to one school slug (`VITE_SCHOOL_SLUG`) and cannot address another API origin.

### Security properties (verified by tests unless marked)

- Renderer: `contextIsolation: true`, `nodeIntegration: false` (also workers/subframes), `sandbox: true`, `webSecurity: true`, no `<webview>`, DevTools only in unpackaged runs. Verified: `desktop/test/security.test.ts`; at run time the page sees no `require`/`process` (`e2e/desktop-tests/smoke.spec.ts`).
- CSP on every `app://` response: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`. A `fetch('https://example.com')` from the page is blocked (smoke test). `img-src https:` exists for school logos (their host sees the user's IP).
- Navigation is locked to `app://shikkha` (`will-navigate`, `will-redirect`), `window.open` is denied, all permission requests/checks are denied, a single instance is enforced.
- IPC: one channel, `desktop:info`, read-only, exposed as `window.shikkhaDesktop.info()` through `contextBridge`; the handler verifies the sender frame URL. No raw `ipcRenderer`, no other channel (static test).
- Electron fuses in packaged builds: `RunAsNode` off, `NODE_OPTIONS` env off, `--inspect` off, `OnlyLoadAppFromAsar` on, file-protocol privileges off, cookie encryption on (verified with `@electron/fuses read`).
- No secrets are packaged: the build reads only the non-secret `profile.json`; `app-config.json` holds slug, display name and API origin. Tests assert the sources reference no database URLs or master key. The API origin must be `https://` (plain `http://` only for explicit loopback **test** builds; release builds reject the flag).
- Not verified here: a real TLS connection from the packaged app to a production API with a private CA (the app uses Chromium's network stack and the **OS trust store**); AppArmor/user-namespace sandboxing on target distributions (the smoke test runs with `--no-sandbox` because CI/containers run as root).

## Building

All steps are reproducible from the repository (`npm ci` first). `desktop/` is an npm workspace.

```bash
# Development: build the UI + shell for a generic (unbranded) build and start Electron
DESKTOP_API_BASE_URL=https://api.example.test npm run dev -w desktop

# School-branded build from the existing build-profile system
npm run petra -- build-profile <slug> https://api.school.example /tmp/profiles      # writes /tmp/profiles/<slug>/profile.json (non-secret)
node desktop/scripts/build.mjs package --profile /tmp/profiles/<slug>               # AppImage + tar.gz in desktop/release/

# Generic build (no school locked; users type the school ID)
SHIKKHAOS_RELEASE=1 npm run package:linux -w desktop -- --api https://api.school.example
```

`petra build-profile` already reads `school_branding` and `school_build_profiles`; the desktop build uses its `platforms[]` entry for `linux` (`app_name`, `app_id`). Register it first with `PUT /api/platform/schools/:id/build-profiles/linux`. The build refuses a profile without a `linux` entry rather than inventing an identity. `desktop/scripts/build.mjs` compiles the shell, builds the **same** `web/` with `VITE_SCHOOL_SLUG`/`VITE_APP_NAME`, writes `build/app-config.json`, then runs electron-builder (`--dir` builds only the unpacked app). Artifacts: `desktop/release/<name>-<version>-linux-x86_64.AppImage` and `…-linux-x64.tar.gz`; CI uploads them with a `SHA256SUMS` file.

### Running on NixOS

NixOS does not provide a conventional dynamic linker, so the downloaded binaries need a compatibility layer. Reproducible options (not exercised in CI; **not tested on NixOS by the author**):

```bash
nix run nixpkgs#appimage-run -- ./shikkhaos-<name>-0.1.0-linux-x86_64.AppImage
# or enable nix-ld (programs.nix-ld.enable = true; add Electron's libraries) and run the extracted tar.gz binary
# or: nix-shell -p steam-run --run "steam-run ./shikkhaos-<name>/shikkhaos-<name>"
```

A native Nix derivation (building from source with `buildNpmPackage` + `electron`) is the proper long-term answer and is on the roadmap.

## Tests

- `npm run test -w desktop` — 22 unit tests (config validation, proxy allow-list/cookie jar against a local stand-in server, static-file traversal, renderer hardening and IPC surface checks). No database, no network beyond loopback.
- `npm run test:desktop -w e2e` — launches Electron under Xvfb against a **real API on the disposable test cluster** (same guard as the other E2E tests): branded launch (fixed school, school name), isolation checks, platform API blocked, login, logout, session rejected afterwards. `test:desktop:packaged` repeats it against the packaged unpacked app (fuses applied). `test:desktop:negative` drops the logout request and must fail on "session must be rejected after logout"; CI checks that.
- Manual verification of the artifacts (as done for the first build): `APPIMAGE_EXTRACT_AND_RUN=1 xvfb-run -a ./x.AppImage --no-sandbox --remote-debugging-port=9555`, then `curl http://127.0.0.1:9555/json/list` shows the `app://shikkha/` page. A graphical desktop/NixOS install test has **not** been performed.

## Roadmap

Each item is a separate PR; none is implemented here.

1. **Windows x64 `.exe`**: electron-builder `nsis` target on a `windows-latest` runner using the same `build.mjs` (`--platform windows`, reading the `windows` build-profile row); code-signing certificate and SmartScreen reputation are the real work; test on a Windows VM.
2. **Android APK / Play AAB**: Capacitor wrapping `web/dist` (the generator already emits `capacitor.config.json`); needs the same session solution as the desktop (a native HTTP client plugin keeping the cookie out of the WebView, or a token mode designed with the platform-admin/MFA work), an Android keystore and a device test. Play Store needs the AAB, signing by Play App Signing, a privacy policy and a data-safety form (children's data).
3. **School-specific icons and names**: add `icon_url`/asset handling to `school_build_profiles` (only reviewed, non-executable images), generate platform icon sets at build time from the profile; `app_name`/`app_id` already flow through.
4. **Secure updates**: `electron-updater` with a signed feed served over HTTPS, `min_supported_version` from `GET /api/public/app-config/:slug` enforced at start-up; requires signing keys and a release process. Until then updates are manual re-installs (`publish` is disabled).
5. **Offline workflows and local storage**: a design decision first (what is cached, conflict rules, encryption of local data with `safeStorage`, remote wipe); the current architecture stores nothing locally except the Chromium profile (language/school preferences).
6. **Google Drive backup/sync**: server-side or operator-side, not in the client; must include encrypted backups, explicit restore verification (digest comparison as in `petra restore`), key management and a restore drill; tracked with the backup-encryption finding H-3.

## Known limitations

Memory-only session (sign in after restart); no code signing, auto-update, icons per school or tray/notifications; Linux x64 only; the CI-built generic artifact points at a placeholder API origin and is for inspection, not for use; AppImage/tar.gz on NixOS need a compatibility layer.
