# OpenMan

A local-first desktop AI workspace, migrated from [upstream OpenMan](https://github.com/nickvasilescu/openman). Tasks, projects, settings, files, transcripts and schedules live on your computer. The desktop shell embeds a Next.js server, PGlite (Postgres in WASM), a Hermes-compatible agent, native host services and a scheduler. No Orgo account or Supabase project is needed in the default configuration.

**Migration status:** the local production server and automated local workflows have been exercised on Linux. Installer targets are configured, not published binaries or a claim of validated Windows/macOS support. Native screen/input permissions, browser automation with an installed browser, actual Whisper model inference and each installer still require platform testing. Optional email, phone, image and audio vendors need their own credentials and internet connectivity; they are not offline services.

## Quick start

Prerequisites: Node.js 22+, npm, git. Install a local model server separately (Ollama or an OpenAI-compatible LM Studio, vLLM or llama.cpp server) and download a **tool-capable** model before going offline.

```bash
npm ci
npm run dev
# Open http://127.0.0.1:3000/app — the laptop owner is signed in automatically.
```

Open **Settings → Account** (or Billing) to select a provider and model. These panes show local model/hardware settings rather than cloud billing. Discovery looks at Ollama on port 11434 or LM Studio on port 1234; an optional loopback base URL supports other ports. Model IDs must match the installed/provider model. Blank per-mode mappings use the default model; Lite, Standard, Max and Flex can each select another model from the same provider.

For the Electron shell (tray, screen capture and launch-at-login):

```bash
npm run desktop:dev
```

For a production server without Electron:

```bash
npm run desktop:build
HOSTNAME=127.0.0.1 PORT=3000 node .next/standalone/server.js
# PowerShell: $env:HOSTNAME='127.0.0.1'; $env:PORT='3000'; node .next/standalone/server.js
```

`desktop:build` prepares the standalone bundle, local fonts, database migrations, PGlite payload, terminal module and icons. It does not create an installer. The source build/install needs internet; the prepared server can boot without external services. Inference is offline only when a downloaded local model is selected. Web search, external websites, connector endpoints and cloud providers naturally need a network.

## Providers and secrets

| Provider | Endpoint / configuration |
|---|---|
| Ollama | `http://127.0.0.1:11434/v1`, no key |
| LM Studio / vLLM / llama.cpp | OpenAI-compatible loopback endpoint (default port 1234), no key |
| Anthropic | Official Messages API, your API key |
| OpenAI | Official OpenAI API, your API key |
| Google Gemini | Official OpenAI-compatible Gemini API, your API key |
| OpenRouter | Official OpenRouter API, your API key |

Saved model configurations and connector secrets use the existing AES-256-GCM `seal`/`open` implementation. API responses omit saved keys. Bootstrap creates random database/session/encryption/scheduler secrets in a private local `secrets.json`; existing environment overrides are honored. Back up the key file **with** the database: losing the encryption key makes saved credentials unreadable. Local file permissions protect against other OS users, not malicious software running as you. This is not an OS sandbox or a replacement for disk encryption.

Environment provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) can seed the initial provider; `OPENMAN_MODEL` overrides its default model ID. Settings take precedence after saving.

## Local architecture and data

- **Next.js 16** uses the existing routes, UI and public API. No route segment runtime/dynamic/revalidation exports are used with Cache Components.
- **PGlite** applies the SQL baseline and subsequent migrations in `supabase/migrations`, recording applied migration names. Database access stays server-only and owner-scoped.
- **Owner session** is automatic for loopback requests, including production. The local server refuses non-loopback Host headers and cross-origin mutations. Do not expose it with a reverse proxy or bind it to a public interface.
- **Agent** listens on `127.0.0.1:8642`; requests require an internal bearer token. It supports model tool loops, durable transcripts, SSE replay, stop/steer, clarify and approvals. Chat/Plan reject action tools.
- **Host services** provide filesystem operations, uploads, a native PTY where available and authenticated terminal transport. A pipe-shell fallback remains available if a native terminal module cannot load; it is not a full PTY.
- **Computer view** uses Electron/native screen capture and one-use stream tickets. OS capture/accessibility permission is required. Shell and desktop/browser actions ask for task approval; file edits can be performed by Agent mode. Agents run with your OS privileges—review prompts and approvals.
- **Websites** run on loopback ports 4100–4199 (preview) and 4300–4399 (release), with persisted service specifications restored on startup. They are not internet deployments. Static serving blocks hidden files and symlink escapes.
- **Scheduler** ticks in-process every 60 seconds using its private cron credential. Keep the app running; closing the window leaves it in the tray. Quit Completely stops the backend. Desktop autostart is enabled on first run and can be toggled in the tray or local settings.

Default locations (override with `OPENMAN_APP_DATA` and `OPENMAN_WORKSPACE`):

| OS | Application data | Workspace |
|---|---|---|
| Windows | `%APPDATA%/OpenMan` | User Documents / `OpenManWorkspace` |
| macOS | `~/Library/Application Support/OpenMan` | `~/Documents/OpenManWorkspace` |
| Linux | `$XDG_DATA_HOME/openman` or `~/.local/share/openman` | `~/OpenManWorkspace` |

Electron uses its platform `userData` directory for application data. On Linux non-Electron configuration honors `XDG_CONFIG_HOME`. `OPENMAN_LOCAL_MODE=1` forces local operation even if old Supabase variables are present. Local mode is otherwise on unless a remote Supabase URL is explicitly configured; `OPENMAN_LOCAL_MODE=0` opts into the historical remote deployment. See [legacy cloud notes](docs/legacy-cloud-deployment.md), not the desktop quick start, for that mode.

## Browser, connectors, skills and transcription

- **Browser:** install Chrome, Chromium or Edge, or set `OPENMAN_BROWSER_EXECUTABLE`. The isolated app profile preserves sign-ins only when enabled in browser settings. No browser binary is fetched on startup. Use `OPENMAN_BROWSER_HEADLESS=1` for environments without a display. Native browser actions require approval. HTTP(S) subrequests use DNS-pinned safeFetch; service workers and WebSockets are blocked in the isolated profile, so sites requiring those features may not work. The profile is separate from your personal browser.
- **MCP:** local mode supports command/stdio and Streamable HTTP connectors directly. Saved command secret fields become environment variables; HTTP secret fields become headers. Loopback HTTP servers are allowed explicitly; remote endpoints require HTTPS. OAuth/vendor integrations still need their vendor configuration. Long-lived SSE streams from servers that never finish a POST may time out; legacy HTTP+SSE transports are not implemented.
- **Custom APIs:** saved credentials are attached to requests on the configured origin only, through `safeFetch` with redirects disabled. Secrets are not interpolated into shell commands.
- **Skills:** list, edit, upload, enable/disable, delete and download work against local skill folders. GitHub/official imports download files through GitHub's API and do not execute them. They need network access and are subject to GitHub rate limits. Review downloaded instructions before using them; importing is not a security audit. Python 3 is required for skill archive/metadata helpers.
- **Meeting transcription:** native detached Python jobs replace POSIX `nohup`/`flock` job control in local mode. With no ElevenLabs key, first use creates a faster-whisper virtual environment and downloads its model; subsequent inference can run offline once dependencies/model are cached. Python 3 (including venv/pip) is required. Actual model execution has not yet been validated on each platform. With an ElevenLabs key, audio is sent to that provider via a streamed upload.
- **Generators:** slide state, bundled styles and single-page HTML export work without a cloud computer. Chart/spreadsheet/PPTX tools bootstrap a native Python venv with pip; first use needs network access and Python venv support. PDF/thumbnail rendering needs installed Chrome/Chromium/Edge. These dependency installs and real renders still need end-to-end validation. Voiceover via edge-tts is an online service, not offline TTS. Image/video generators require a ready MCP connector explicitly advertising `image_generate`/`generate_image` or `video_generate`/`generate_video`; adding a language-model API key alone does not install a media model. Local research batches run within the agent rather than using an unavailable delegation tool.
- **Linux desktop input:** requires X11 and `xdotool`; native non-Electron capture uses `gnome-screenshot` or `scrot`. Wayland restrictions may prevent input/capture. macOS requires Accessibility/Screen Recording permission. Windows runs input helpers via PowerShell.

## Build installers

```bash
npm run dist:win    # NSIS wizard + MSI + portable EXE: x64, arm64, ia32
npm run dist:linux  # AppImage, deb, rpm: x64, arm64
npm run dist:mac    # dmg, pkg, zip: universal
npm run dist:all    # Dispatch the pushed GitHub Actions workflow using authenticated gh
```

Use native OS/architecture builders for native dependencies. Windows ia32 native modules need an x86 toolchain; macOS universal packaging needs both architectures. No Electron binary is included in source control. Signing/notarization requires your distribution certificates; the workflow does not invent credentials or claim signed artifacts. Unsigned packages can trigger OS warnings.

`electron-builder.yml` contains icons, entitlements, wizard options and target definitions. `.github/workflows/build-installers.yml` verifies tests/build, then runs the platform matrix and uploads artifacts (14-day retention). Trigger it manually or push a version tag. `dist:all` requires the workflow to exist on the pushed current branch. This workspace has not produced or installed those packages; inspect every matrix job and perform native acceptance tests before publishing a release.

## Verification

Detailed evidence, platform gaps and the installer download blocker are recorded in [Local migration status](docs/LOCAL_MIGRATION_STATUS.md).

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npx tsc -p electron/tsconfig.json
npm run safe-fetch-test
npm run redact-test
npm run local:test
npm run desktop:build
node scripts/local-production-smoke.mjs
# Repeat with local mode unset, rather than forced on:
OPENMAN_SMOKE_DEFAULT=1 node scripts/local-production-smoke.mjs
```

The isolated local integration suite covers real PGlite migrations/query operations, encrypted configuration, owner session, filesystem/upload/shell, detached native jobs, MCP stdio and HTTP sessions, website serving protections, agent tool execution/SSE replay, terminal sessions, and authenticated scheduler tick transport. The scheduler test executes a due persisted automation through the real task engine and waits for its task to finish. Native site tests also exercise the preview inspector, published full-stack sign-in/notes, source-site SQLite, database helper, checkpoints, and secret-free archives. The production smoke test starts the prepared standalone server with no cloud configuration, exercises the UI task API/relay and real cron endpoint, checks Host/CSRF protections, and rejects/records attempted Orgo/Supabase requests. The default invocation also sets a fake remote Supabase URL to verify that `OPENMAN_LOCAL_MODE=1` wins; `OPENMAN_SMOKE_DEFAULT=1` checks default-local selection without that URL. Its model endpoint is a loopback test double: it proves wiring, not model quality or real-provider interoperability.

No test suite here substitutes for macOS/Windows installation, native desktop permission/input tests, real provider compatibility, or complete feature-parity acceptance. [Upstream project status](docs/legacy-cloud-deployment.md#project-status) also lists limitations inherited from the original application.

## Contributing, license and safety

See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md), [NOTICE](NOTICE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and the [MIT License](LICENSE). Copyright © 2026 Organic Intelligence, Inc. Branding is centralized in `src/config/brand.ts` and `public/brand/`. OpenMan/Orgo names and logos remain subject to [TRADEMARKS.md](TRADEMARKS.md); redistributed forks must follow those terms.

Autonomous agents take real actions under your account. You are responsible for configuration and approvals. Read [DISCLAIMER.md](DISCLAIMER.md). Do not use untested builds for sensitive or unattended work.
