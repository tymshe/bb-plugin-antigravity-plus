# Provider capabilities

Verified against Antigravity CLI 1.5.16 on macOS (BB Desktop), 1.5.14 on Linux, and 1.5.1+ on Windows with BB SDK 0.6.157. A terminal CLI feature does not imply that the same feature is exposed through ACP.

| Feature | Current integration |
| --- | --- |
| Streaming, tools, approvals | The host forwards the original JSONL line if a transform throws. The proxy translates executor-busy prompt errors so the shared bridge can retry. |
| Native Swarm board tab and pill | The `Swarm` tab and composer pill show the active swarm. The read-only host RPC uses the session's recorded app data directory and falls back to the host profile when the binding lacks a path. |
| Swarm timeline cards | Clean tool cards for `swarm` (`title`, `add`, `kill`, `status`, `models`, `model`), `post_message`, `read_board`, and `swarm_wait` |
| Native system prompts | The proxy applies BB's `<system_instructions>` on load and resume. It prunes old instructions for deleted conversations in the current app data directory. |
| Background commands & agents | Background commands, schedules, and subagents have persistent task banners. A command can keep its banner after the turn ends. Text in command cards or transcript tool results cannot close another task. Task status uses the exit code to classify success or failure. |
| Subagent delegation control | `subagentsDisabled` instructs agents to delegate via BB and denies native subagent tool approvals. Approval titles are used only when the tool name is absent. |
| Command & tool presentation | Command cards show output once and preserve literal stdout after the wrapper. Cards also show exit codes, optional `toolSummary` descriptions, and **Outside of sandbox** badges for `BypassSandbox`. |
| Sandbox-escape guard | `acceptEditsApproval` setting (`ask` default, `auto-in-sandbox`, or `auto-all`) lets you auto-approve routine in-sandbox requests in Accept edits mode while still prompting for **Outside of sandbox** commands |
| Model catalog and reasoning | Host-scoped model cache (`models.scope: "host"`); supports `low`, `medium`, `high`, `xhigh`, and `max` depending on model and account |
| Plan/Build | One Mode selector mapped to native Plan/Accept edits with provider-specific `planModeCopy` and no duplicate Plan action |
| Accept edits / Full access | Shared bridge permission policy |
| Per-session worker isolation | `--process-per-session` gives each thread its own worker. The proxy strips `ELECTRON_RUN_AS_NODE` before launching `agy` or probing its version. |
| CLI terminal sandbox | Inherits CLI settings; optional `sandbox` flag adds `--sandbox` for new threads |
| Profile, proxy, and compaction env passthrough | Declares `env.passthrough` for `BB_ANTIGRAVITY_GEMINI_DIR`, `BB_ANTIGRAVITY_APP_DATA_DIR`, `BB_AGY_ACP_PROXY`, and `AGY_CLI_AUTO_COMPACT_OVERRIDE` (`agy 1.5.15+`), forwards profile flags to `agy acp`, and persists hashed profile bindings across restarts to reject profile drift before spawning `agy` |
| Auth-aware CLI health, install, and update | Implements `provider/health` (offline version + zero-turn `/usage` auth check guiding to `agy acp --login`), `provider/installation/status` (dynamic latest-version check via `install.sh` platform manifest when `checkUpdates: true`), and `provider/installation/run` (`Install` + `agy update`, minimum `1.5.0`) |
| Native skills in BB picker | Workspace `.agents/skills` (ancestors) and `.agent/skills`; user `.gemini/antigravity-cli/skills`, `.gemini/skills`, `.gemini/config/skills`, and `.agents/skills` (lowest-precedence cross-agent fallback). CLI-internal builtin skills stay internal to `agy`. |
| Tip fork | Supported (`fork: "tip"`) through the ACP proxy (`VACUUM INTO` + ID swap + `brain/` copy), with automatic pass-through if `agy` advertises native `session/fork` |
| Manual and automatic compaction | Manual `/compact` (`agy 1.5.14+`) verifies a new transcript checkpoint. A regular turn clears a pending manual request that never opened a compaction card. If the transcript shrinks, automatic tracking starts from the new end. |
| Subscription quota/usage | `agy -p "/usage" --output-format json` supplies quota data to BB. A transient host or provider lookup error reports usage unavailable and preserves the last observation. |
| Session rewind / message edit | Disabled: `agy acp` does not expose `session/rewind` |
| Native `ask_question` UI | Disabled: BB's shared ACP bridge does not map `ask_question` tool calls to interactive question cards |
| Native archive/rename | Disabled: `agy acp` does not expose archive or rename operations |
| BB Auto permission profile | Unsupported by the shared ACP bridge |

Run `npm run smoke -- --capabilities --features --modes` for a protocol check in a temporary workspace. Add `--usage` to verify the CLI version and quota windows with a signed-in CLI. Set `BB_AGY_ACP_PROXY=0` to bypass the ACP proxy for troubleshooting.
