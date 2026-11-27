---
name: antigravity-plus
description: Spawn, configure, or troubleshoot Antigravity Provider + (antigravity-plus) threads in BB, including models, reasoning levels (low, medium, high, xhigh, max), Swarm board, quota windows, Build/Plan work modes, tip forking, manual compaction, permissions, and sign-in.
---

# Antigravity Provider +

Threads on `antigravity-plus` run the locally installed Antigravity CLI (`agy acp --disable-telemetry --process-per-session`) through BB's shared ACP bridge and the plugin's local ACP proxy.

## Models and reasoning levels

`antigravity-plus` caches CLI-discovered models per host (`models.scope: "host"`) and exposes per-model reasoning efforts (`low`, `medium`, `high`, `xhigh`, `max`, depending on the model). Fixed-effort models (such as `gpt-oss-120b-medium`) report `supportedReasoningEfforts: []`.

- Plain `bb provider models antigravity-plus` prints only the model table and `sessionOptions` (`mode`), omitting reasoning levels. Always pass `--json` when inspecting reasoning support:

```sh
bb provider models antigravity-plus --environment "$BB_ENVIRONMENT_ID" --json
```

- Pass reasoning level with `--reasoning-level` (not `--option`):

```sh
bb thread spawn --project "$BB_PROJECT_ID" --provider antigravity-plus --model gemini-4-neon --reasoning-level high --prompt "..."
```

## Work modes and permissions

Plan and permission mode are separate controls:

- **Plan (`/plan` in the composer, `bb thread spawn --plan`).** Selects agy's native Plan mode for that message: research and outline before editing (behavioral guidance, not enforced read-only access). There is no separate Mode option; agy's raw mode select is hidden.
- **Questions.** agy's `ask_question` tool arrives as an ACP form and BB shows it as a question card with choices and free text.
- **Permission mode (`--permission-mode <accept-edits|auto|full>`).** `accept-edits` runs workspace edits natively and handles other ACP prompts according to `acceptEditsApproval` (`ask`, `auto-in-sandbox`, or `auto-all`). `full` lets BB's shared bridge auto-approve every ACP request, including out-of-sandbox commands. `auto` switches the agy session to Antigravity's native Auto mode (agy 1.5.4+): Antigravity reviews its own tool calls, and requests it escalates come to the user as approvals. The plugin hands BB's shared ACP bridge Accept edits (the bridge rejects `auto`) and selects native `mode=auto`; Plan wins over Auto. If the session does not advertise `auto`, the thread runs in Accept edits and shows a one-time warning.

## Swarms in BB

Start a multi-agent swarm with `/swarm`. Antigravity supports pinning different models per worker (`swarm(action: "models", all: true)`, `swarm(action: "add", model: "...")`, `swarm(action: "model", ...)`).

- **Native Swarm UI.** Threads with an active swarm show a fixed **Swarm** right-panel tab (auto-opened on start via `autoOpenSwarmBoard`), a clickable context pill above the composer, and readable timeline cards for `swarm`, `post_message`, `read_board`, and `swarm_wait`.
- **Workspace permission note.** In Accept edits mode, keep worker file targets inside the thread's active workspace. A worker trying to access files outside the workspace times out after 60 seconds because worker approval prompts do not route through the coordinator's ACP channel. Use in-workspace targets or Full access mode.
- **Board lifecycle.** Swarm files under `<appData>/brain/<conversationId>/.system_generated/swarm/` are read-only audit logs and stay on disk. The coordinator cleans up isolated worker worktrees with `swarm(action: "kill", ...)`.

## Requirements and settings

- `agy` 1.5.0+ (`1.5.14+` recommended for `/compact`) must be installed on the target host (`agy --version`, `agy acp --help`).
- Sign in on the target host with `agy acp --login`.
- Plugin settings (`Settings -> Installed plugins -> Antigravity Provider +`):
  - `autoOpenSwarmBoard` (default `true`): open the **Swarm** side-panel tab once when `/swarm` starts on a thread.
  - `commandDescriptionsEnabled` (default `true`): show Antigravity's `toolSummary` as each command card's title with the raw command underneath.
  - `subagentsDisabled` (default `false`): disable native CLI subagent tools so agents delegate via BB child threads (`bb thread spawn --parent-self`). Does not affect `/swarm`.
  - `acceptEditsApproval` (default `"ask"`): Accept edits approval policy (`ask`, `auto-in-sandbox`, or `auto-all`).
  - `sandbox` (default `false`): pass `--sandbox` for new threads instead of inheriting CLI settings.

## Capabilities, env passthrough, and limits

- **Native system prompts.** BB thread and skill instructions move into `_meta.antigravity.systemPrompt.append` and re-apply on session load and resume.
- **Tip forking (`fork: "tip"`).** Forks at the latest message through the ACP proxy, or natively if a future `agy` release advertises `sessionCapabilities.fork`. Mid-thread rewind is unsupported.
- **Manual and automatic compaction.** Runs native `/compact` (`agy 1.5.14+`) with failure detection if the CLI sends `/compact` to the model, and surfaces automatic Antigravity compactions as native **Compacted context** items in BB's thread timeline.
- **Environment passthrough.** `BB_ANTIGRAVITY_GEMINI_DIR` and `BB_ANTIGRAVITY_APP_DATA_DIR` forward as `--gemini-dir` and `--app-data-dir`. `AGY_CLI_AUTO_COMPACT_OVERRIDE` (`agy 1.5.15+`, e.g. `80%` or `700K`) sets the auto-compaction threshold via `bb machine env`. Set `BB_AGY_ACP_PROXY=0` to bypass the local ACP proxy for troubleshooting.
- **Native skills.** Workspace `.agents/skills` (ancestors) and `.agent/skills`; user `~/.gemini/antigravity-cli/skills`, `~/.gemini/skills`, `~/.gemini/config/skills`, and `~/.agents/skills`. CLI-internal builtin skills stay internal to `agy`.
- **Usage limits.** Exposed via `provider/usage` and `provider-usage.v1` (`bb settings usage --refresh --json`).
