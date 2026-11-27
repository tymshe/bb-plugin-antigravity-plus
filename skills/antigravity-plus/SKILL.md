---
name: antigravity-plus
description: Spawn, configure, and troubleshoot Antigravity Provider + (antigravity-plus) threads in BB. Covers models, reasoning, /plan, Auto permissions, question cards, Swarm, quota windows, tip forking, compaction, and sign-in.
---

# Antigravity Provider +

Threads on `antigravity-plus` run the locally installed Antigravity CLI (`agy acp --disable-telemetry --process-per-session`) through BB's shared ACP bridge and the plugin's local ACP proxy.

## Models and reasoning levels

`antigravity-plus` caches CLI-discovered models per host (`models.scope: "host"`) and exposes per-model reasoning efforts (`low`, `medium`, `high`, `xhigh`, `max`, depending on the model). Fixed-effort models (such as `gpt-oss-120b-medium`) report `supportedReasoningEfforts: []`.

- Pass `--json` to inspect per-model reasoning support:

```sh
bb provider models antigravity-plus --environment "$BB_ENVIRONMENT_ID" --json
```

- Pass reasoning level with `--reasoning-level` (not `--option`):

```sh
bb thread spawn --project "$BB_PROJECT_ID" --provider antigravity-plus --model gemini-4-neon --reasoning-level high --prompt "..."
```

## Work modes and permissions

- **Plan.** Use `/plan` in the composer or pass `--plan` to `bb thread spawn`. Native Plan takes precedence over Auto and guides the agent to research and outline before editing. Plan does not enforce read-only access.
- **Accept edits (`--permission-mode accept-edits`).** Workspace edits run natively. Other requests use `acceptEditsApproval`.
- **Auto (`--permission-mode auto`).** Antigravity reviews its own tool calls. You receive escalation prompts in BB. If the session lacks Auto, BB warns once per thread and uses Accept edits with user review.
- **Full access (`--permission-mode full`).** BB auto-approves ACP requests, including out-of-sandbox commands.
- **Questions.** BB shows `ask_question` as a card with choices and free text.

## Swarms in BB

Start a multi-agent swarm with `/swarm`. Antigravity supports pinning different models per worker (`swarm(action: "models", all: true)`, `swarm(action: "add", model: "...")`, `swarm(action: "model", ...)`).

- **Native Swarm UI.** Threads with an active swarm show a fixed **Swarm** right-panel tab (auto-opened on start via `autoOpenSwarmBoard`), a clickable context pill above the composer, and readable timeline cards for `swarm`, `post_message`, `read_board`, and `swarm_wait`.
- **Workspace permission note.** In Accept edits mode, keep worker file targets inside the thread's active workspace. A worker trying to access files outside the workspace times out after 60 seconds because worker approval prompts do not route through the coordinator's ACP channel. Use in-workspace targets or Full access mode.
- **Board lifecycle.** Swarm files under `<appData>/brain/<conversationId>/.system_generated/swarm/` are read-only audit logs and stay on disk. The coordinator cleans up isolated worker worktrees with `swarm(action: "kill", ...)`.

## Requirements and settings

- Install `agy 1.5.0+` on the target host. Run `agy --version` to check it.
- Auto requires `agy 1.5.4+`, account rollout, and the OS terminal sandbox. Enable the CLI sandbox in plugin settings if needed.
- Manual `/compact` requires `agy 1.5.14+`. Native `ask_question` cards require `agy 1.5.18+`.
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
