# Security and public-source review

Reviewed the provider declaration, host bridge and ACP proxy, Swarm host RPC reader, frontend Swarm tab, tests, smoke script, manifest, lockfile, documentation, screenshots, and generated package inventory for `bb-plugin-antigravity-plus`.

- Plugin-owned runtime code contains no shell command construction, HTTP server route, credential parser, telemetry collector, or install hook. Subprocess execution goes through BB's shared ACP bridge, `experimental_hostToolchain`, or fixed `execFile` arguments (`agy --version`, `agy -p "/usage"`). When BB requests CLI update checks (`checkUpdates: true`), `maintenance.ts` performs read-only HTTPS GET fetches against Google's official Antigravity installer and release manifest with no local identifiers or credentials.
- `readSwarmBoard` validates `providerThreadId` as a UUID. It reads from the session's recorded app data directory when available and falls back to the host profile for older bindings. Reads are capped at 200 recent messages and 8,000 characters per post.
- The ACP proxy strips `ELECTRON_RUN_AS_NODE` from the environment for `agy acp` and `agy --version`. Instruction cleanup requires a matching app data directory and a missing conversation database. Legacy records without a directory stay in the store.
- Fixed launch arguments preserve vendor approval checks in Accept edits mode, disable CLI telemetry, and isolate each session (`--process-per-session`). `acceptEditsApproval` defaults to `"ask"`, and `"auto-in-sandbox"` keeps out-of-sandbox requests prompting even when routine requests auto-approve. Explicitly selecting Full access or `"auto-all"` allows out-of-sandbox requests to approve automatically.
- No account identifiers, personal email addresses, home-directory paths, tokens, CLI state, or private conversations are bundled in release files or screenshots. Package contents use an explicit `files` allowlist and exclude `.map` source maps, `.env` files, logs, and local runtime state.
- MIT applies to this fork's source and upstream `ols-md/bb-plugin-antigravity` source. Dependencies and Google's Antigravity CLI retain their own terms.

Prior release verification covered macOS (BB Desktop and `agy 1.5.16`), Linux (`agy 1.5.14`), and Windows (`agy 1.5.1+`). It covered builds, the shared bridge suite, live CLI mode checks, provider maintenance, and multi-worker Swarm threads.

The suite covers retry of a busy prompt through the shared ACP bridge and task output that resembles completion announcements. CI fails if tests create `.bb` under the isolated home. The release checker validates the provider declaration and settings with the SDK. The opt-in `--usage` smoke check requires a parseable CLI version and a schema-valid response with quota windows.
