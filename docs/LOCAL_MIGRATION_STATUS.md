# Local migration verification

Checkpoint: 2026-11-27. This is an implementation/verification record, not a declaration of full upstream feature parity or a published desktop release.

## Verified in this Linux workspace

- `npm run typecheck`: Next route generation and application TypeScript pass.
- `npm run lint -- --max-warnings 0`: repository-wide ESLint passes (including scripts).
- `npx tsc -p electron/tsconfig.json`: Electron main/preload compile.
- Safe-fetch and redaction suites pass. The production private-address policy remains the default. Explicit local MCP endpoints have a separate desktop-only, DNS-pinned loopback opt-in; arbitrary LAN/metadata destinations remain refused.
- Electron-builder configuration validates against the installed builder's schema.
- The prepared standalone bundle contains PGlite/WASM, SQL migrations, offline fonts, Playwright runtime metadata and native terminal files. The Linux native PTY module was compiled against installed Node headers and loaded successfully from the standalone bundle.
- The latest `npm run desktop:build` and both production smoke tests pass after the native generator/readiness changes: (a) forced-local mode despite a configured fake Supabase URL and (b) local mode unset with no remote database configured. They exercise automatic production sign-in, local account/computer/provisioning APIs, terminal tickets, Host and CSRF refusal, model settings, UI task relay, matching tool event IDs, authenticated cron requests, and loopback HTTP MCP connector creation/removal. The internal desktop readiness endpoint accepts only the matching instance bearer token and refuses missing/wrong tokens and browser Origin headers. Media capability discovery follows adding/removing a mock MCP image tool. Orgo/Supabase request attempts are rejected and recorded; the exercised paths made none. Build/smoke output is in the ignored `.data-build.log`.
- Inference in automated tests uses a loopback test model, not a paid API or a real downloaded model.

## Integration suite coverage

`node scripts/local-mode-test.mjs` runs isolated app data and real local services:

1. PGlite baseline/migration ledger, query adapter, account upserts, settings and rate-limit RPC. A separate three-process restart test verifies a newly added migration is applied to a persisted database once, then skipped on the following restart.
2. Secret bootstrap, encrypted model configuration and owner session.
3. Filesystem reads/writes, native shell and upload transfer.
4. Detached Python job completion and generated Whisper/Scribe program syntax.
5. MCP stdio initialization, environment credentials, early-process-exit errors, HTTP initialization/session/termination, and selecting the matching response from SSE.
6. Static site serving protections, process readiness/stop, bind errors and symlink/hidden-file refusal.
7. Native site-kit preview inspector; published full-stack account creation and notes; SQLite state in the original site folder; Python database helper.
8. Native git checkpoints and source archive exclusion of secrets, private state and symlinks.
9. Agent authentication, tool execution, durable transcript wire format, SSE replay, shell cancellation, read-only rejection, request idempotency, approval execution and stale-generation refusal. An interrupted tool run is resumed with an explicit unknown-outcome result rather than an invalid unanswered tool call.
10. Authenticated terminal transport.
11. Authenticated scheduler transport invoking the real engine with a due persisted automation; the resulting task completes before teardown.
12. Native generator probing, slide state, bundled CSS, and offline single-page HTML export. Executed helper commands preserve task paths containing spaces and apostrophes. PowerShell interpreter quoting is asserted as text, not executed on Windows. Local task contracts use todo/web_fetch, avoid imaginary vision/delegation tools, and explicitly disclose missing media-generation capability. Research batches run sequentially in the local agent rather than pretending a delegation tool exists.
13. Mock-protocol tool loops for Anthropic, OpenAI, Gemini, OpenRouter and LM Studio, including instructions, model selection and array-schema validation. These do not establish live-provider compatibility.

## Implemented but not validated end-to-end here

- Electron tray, window close-to-tray, launch-at-login defaults/toggle and lifecycle on real desktop sessions.
- Windows/macOS screen capture, permission prompts, pointer/keyboard input and platform native PTYs.
- Browser actions with an installed Chrome/Chromium/Edge. The isolated browser blocks service workers/WebSockets and routes HTTP(S) through safeFetch; compatibility with websites needing those transports is limited.
- Actual Whisper dependency/model installation and inference on each platform. Python job mechanics and generated code syntax are tested, not speech recognition quality.
- Generator virtual-environment/package installation, real chart/spreadsheet/PPTX rendering and Chrome thumbnail/PDF export. Bootstrap now uses native Python venv/pip without executing a downloaded shell installer; installation locks time out but are not automatically recovered after a crash. The real package downloads remain untested. Edge TTS requires network access; it is not an offline speech engine.
- Image/video generation through a real MCP provider. Local availability recognizes ready MCP connectors explicitly advertising image_generate/generate_image or video_generate/generate_video, and task instructions identify the connector/tool and require schema inspection. A language-model key or legacy ~/.hermes configuration alone does not enable those generators. Capability discovery is tested with a mock connector, not an actual media model.
- Live Anthropic/OpenAI/Gemini/OpenRouter, Ollama and LM Studio interoperability/model quality. Settings, encrypted storage, request adapters and test-model execution exist.
- GitHub/official skill import against live repositories, vendor OAuth, email/phone/media integrations and every inherited public API workflow.
- Website cron execution, AI provider calls, browser screenshots and restart recovery across a real desktop reboot. Website runtime wiring and relevant file/state paths are implemented.

## Installer verification

The native-platform matrix and target configurations exist for Windows NSIS/MSI/portable (x64/arm64/ia32), Linux AppImage/deb/rpm (x64/arm64), and macOS dmg/pkg/zip (universal). Config validation is not an installer test.

A Linux x64 unpacked packaging attempt using:

```sh
npx electron-builder --config electron-builder.yml --linux --dir --x64 --publish never
```

failed while acquiring Electron with `unable to verify the first certificate`. Direct Electron installation hit the same certificate failure. Retrying with `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` instead failed with `Client network socket disconnected before secure TLS connection was established`. TLS verification was not disabled. No installer or runnable Electron bundle was produced in this local workspace during that attempt.

### Native CI follow-up

PR #1 now runs verification and the native installer matrix for same-repository pull requests (fork PRs run verification only). Manual workflow dispatch was refused by the connected GitHub integration with HTTP 403, so these builds run through PR events. Artifacts are retained in GitHub Actions for 14 days; they are not a signed/notarized public release.

- The initial matrix built Linux artifacts, but subsequent packaged-runtime checks exposed missing root server dependencies: electron-builder excludes a source root's node_modules unless it is explicitly mapped. The configuration now maps server/node_modules separately. A regression test exercises the builder's real copy filters and verifies copied dependencies.
- Windows MSI initially failed on Next's directory aliases. Preparation now materializes those aliases, with traversal/idempotency regression tests.
- Matrix commands now specify target formats explicitly, so a per-architecture job cannot silently build every architecture from the default configuration.
- The unsupported macos-14 runner label was replaced by macos-15-intel. Electron metadata is staged separately from the Next development dependency tree. Universal macOS preparation includes exact-version sharp/libvips packages and PTY prebuilds for both architectures. An after-pack hook copies those architecture-aware server resources into the merged app once, avoiding the universal merger's per-file subprocess scan over two identical server trees. A separate Apple Silicon job tests the produced universal ZIP, in addition to acceptance on its Intel builder.
- All requested installer formats were produced in run 46156851225. Windows x64/arm64/ia32 and Linux x64/arm64 passed packaged acceptance. Both Mac architectures correctly failed PTY execution: npm's published spawn-helper files had mode 0644. Preparation now explicitly sets both helpers to 0755; hook regression tests verify executable bits survive resource copying. Mac acceptance must be rerun before claiming the fix is verified on native hosts.
- `scripts/packaged-runtime-smoke.mjs` tests the actual packaged Electron runtime, native PTY loading/execution, forced/default-local production boot, and GUI lifecycle with Playwright. GUI checks cover owner session, preload isolation, first-launch autostart and its toggle, close-to-tray/reopen, and backend shutdown. They use isolated data; Linux GUI automation uses Xvfb with a test-only --no-sandbox argument. Shipping BrowserWindow isolation/sandbox settings remain enabled.
- These new native checks must pass before the artifacts are described as verified. They do not automate installer wizards, reboot/login, OS permission dialogs, signing/notarization, real models or live external integrations.

- A full dependency audit identified high-severity advisories in the original Electron 37 runtime. Electron is now pinned to 42.11.18, whose release assets include every required architecture (including Windows ia32). The updated lockfile audit reports zero high/critical findings and six moderate build-tool findings. Production dependencies alone report zero findings. CI gates on high-severity findings; a clean audit is not a guarantee against all vulnerabilities.

Follow the latest matrix through [PR #1 checks](https://github.com/DeepuExplainsAi/SuperMan/pull/1/checks). Corrected native acceptance checks were still pending when this follow-up entry was prepared. Earlier artifacts are superseded test builds, not proof of working packages.

## Remaining acceptance work

Do not label the migration 100% complete until the installer matrix succeeds, the packages are installed/launched on their target architectures, native desktop/autostart behavior is tested, real model/provider workflows pass, and the remaining upstream features receive end-to-end parity checks. Local-only operation does not itself replace external vendors with offline equivalents: integrations explicitly selected by the user still need those vendors and credentials.

See the root README for setup, data locations, providers, build commands and known runtime requirements. Keep build outputs, downloaded binaries and test databases outside Git.
