import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgyAppDataDir } from "./agy-fork.ts";
import { resolveAntigravityLaunchProfile } from "./cli.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const MAX_SEEN_STEPS = 256;

const COMPACTION_LABEL = {
  pending: "Compacting context",
  completed: "Compacted context",
} as const;

const COMPACTION_ICON = { glyph: "Archive" } as const;
const AUTO_COMPACTION_PREFIX = "agy-auto-compact:";
const MISSING_CHECKPOINT = "Antigravity did not write a new compaction checkpoint. Check the session transcript and retry after a conversation turn.";

export interface AutoCompactionCheckpoint {
  stepIndex: number;
  beforeTokens: number | null;
  summaryTokens: number | null;
}

export interface AutoCompactionTrackerOptions {
  /** Bounded maximum bytes read from transcript.jsonl per incremental scan. */
  maxReadBytes?: number;
  /** Override transcript path resolution (primarily for tests). */
  resolveTranscriptPath?: (providerThreadId: string, appDataDir: string) => string;
  /** Override default home directory when resolving appDataDir. */
  home?: string;
}

interface ThreadCompactionState {
  appDataDir: string;
  providerThreadId: string | null;
  transcriptPath: string | null;
  offset: number;
  manual: ManualCompaction | null;
  seenSteps: Set<number>;
}

interface ManualCompaction {
  open: Record<string, any> | null;
  checkpoint: AutoCompactionCheckpoint | undefined;
  postUsedTokens: number | null;
}

function compactionItemKey(delta: Record<string, any>): string | null {
  if (delta.item?.type !== "compaction") return null;
  const { providerItemId, channel } = delta.key ?? {};
  if (typeof providerItemId === "string") {
    return providerItemId.startsWith(AUTO_COMPACTION_PREFIX) ? null : `id:${providerItemId}`;
  }
  return typeof channel === "string" ? `channel:${channel}` : null;
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  return String(Math.round(tokens));
}

function formatCompactionDetail(
  checkpoint: AutoCompactionCheckpoint,
  postUsedTokens: number | null,
): string | undefined {
  const before = checkpoint.beforeTokens;
  if (before !== null && postUsedTokens !== null && postUsedTokens < before) {
    return `${formatCompactTokens(before)} -> ${formatCompactTokens(postUsedTokens)} tokens`;
  }
  if (before !== null && checkpoint.summaryTokens !== null) {
    return `${formatCompactTokens(before)} tokens -> ${formatCompactTokens(checkpoint.summaryTokens)} summary`;
  }
  if (before !== null) {
    return `from ${formatCompactTokens(before)} tokens`;
  }
  return undefined;
}

function defaultTranscriptPath(providerThreadId: string, appDataDir: string): string {
  return join(appDataDir, "brain", providerThreadId, ".system_generated", "logs", "transcript.jsonl");
}

function fileSizeOrZero(path: string): number {
  if (!existsSync(path)) return 0;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    return fstatSync(fd).size;
  } catch {
    return 0;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function parseCheckpointLine(line: string): AutoCompactionCheckpoint | null {
  if (!line.includes('"CHECKPOINT"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const entry = parsed as Record<string, unknown>;
  if (entry.type !== "CHECKPOINT") return null;
  if (entry.status !== undefined && entry.status !== "DONE") return null;
  const stepIndex = typeof entry.step_index === "number" && Number.isInteger(entry.step_index) && entry.step_index >= 0
    ? entry.step_index
    : null;
  if (stepIndex === null) return null;

  const input = typeof entry.input_tokens === "number" && Number.isFinite(entry.input_tokens) ? entry.input_tokens : 0;
  const cacheRead =
    typeof entry.cache_read_tokens === "number" && Number.isFinite(entry.cache_read_tokens)
      ? entry.cache_read_tokens
      : 0;
  const totalBefore = input + cacheRead;
  const summaryTokens =
    typeof entry.output_tokens === "number" && Number.isFinite(entry.output_tokens) && entry.output_tokens > 0
      ? entry.output_tokens
      : null;

  return {
    stepIndex,
    beforeTokens: totalBefore > 0 ? totalBefore : null,
    summaryTokens,
  };
}

function buildAutoCompactionDeltas(
  checkpoint: AutoCompactionCheckpoint,
  postUsedTokens: number | null,
): Record<string, unknown>[] {
  const key = { providerItemId: `${AUTO_COMPACTION_PREFIX}${checkpoint.stepIndex}` };
  const detail = formatCompactionDetail(checkpoint, postUsedTokens);
  const presentation = {
    label: COMPACTION_LABEL,
    icon: COMPACTION_ICON,
    ...(detail ? { detail } : {}),
  };
  return [
    {
      kind: "item.open",
      key,
      item: { type: "compaction" },
      presentation,
    },
    {
      kind: "item.close",
      key,
      status: "completed",
      item: { type: "compaction" },
      presentation,
    },
    {
      kind: "context.compacted",
    },
  ];
}

/**
 * Surfaces Antigravity CLI automatic compactions as native BB timeline items.
 *
 * `agy acp` emits no ACP notification when auto-compaction fires, and BB's shared ACP bridge only
 * opens compaction items for manual `/compact`. This module watches incremental `CHECKPOINT`
 * records in `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` on
 * outbound `contextWindow` and `turn.boundary` deltas (zero background timers) and injects BB's
 * native `compaction` item + `context.compacted` delta once per new automatic checkpoint.
 */
export function createAutoCompactionTracker(options?: AutoCompactionTrackerOptions) {
  const maxReadBytes = Math.max(4096, options?.maxReadBytes ?? DEFAULT_MAX_READ_BYTES);
  const resolveTranscriptPath = options?.resolveTranscriptPath ?? defaultTranscriptPath;
  const home = options?.home ?? homedir();
  const threads = new Map<string, ThreadCompactionState>();

  function getOrCreateState(threadId: string, appDataDir?: string): ThreadCompactionState {
    let state = threads.get(threadId);
    if (!state) {
      state = {
        appDataDir: appDataDir ?? resolveAgyAppDataDir([], home),
        providerThreadId: null,
        transcriptPath: null,
        offset: 0,
        manual: null,
        seenSteps: new Set<number>(),
      };
      threads.set(threadId, state);
    } else if (appDataDir) {
      state.appDataDir = appDataDir;
    }
    return state;
  }

  function rememberSeenStep(state: ThreadCompactionState, stepIndex: number): void {
    if (state.seenSteps.size >= MAX_SEEN_STEPS) {
      const oldest = state.seenSteps.values().next().value;
      if (oldest !== undefined) state.seenSteps.delete(oldest);
    }
    state.seenSteps.add(stepIndex);
  }

  function bindProviderThread(state: ThreadCompactionState, providerThreadId: string): void {
    if (!UUID_PATTERN.test(providerThreadId)) return;
    if (state.providerThreadId === providerThreadId && state.transcriptPath) return;
    state.providerThreadId = providerThreadId;
    state.transcriptPath = resolveTranscriptPath(providerThreadId, state.appDataDir);
    // Baseline at current file size so resuming a thread never replays historical checkpoints.
    state.offset = fileSizeOrZero(state.transcriptPath);
    state.seenSteps.clear();
  }

  function beginManualCompaction(state: ThreadCompactionState, open: Record<string, any> | null): void {
    if (state.transcriptPath) state.offset = fileSizeOrZero(state.transcriptPath);
    state.manual = { open, checkpoint: undefined, postUsedTokens: null };
  }

  function scanNewCheckpoints(state: ThreadCompactionState): AutoCompactionCheckpoint[] {
    const transcriptPath = state.transcriptPath;
    if (!transcriptPath || !existsSync(transcriptPath)) return [];

    let fd: number | null = null;
    try {
      fd = openSync(transcriptPath, "r");
      const size = fstatSync(fd).size;
      if (size < state.offset) {
        state.offset = size;
        return [];
      }
      if (size <= state.offset) return [];

      let startOffset = state.offset;
      let droppedLeadingPartial = false;
      if (size - startOffset > maxReadBytes) {
        startOffset = size - maxReadBytes;
        droppedLeadingPartial = true;
      }

      const length = size - startOffset;
      const buf = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, buf, 0, length, startOffset);
      if (bytesRead <= 0) return [];

      const slice = buf.subarray(0, bytesRead);
      const lastNewline = slice.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        // Incomplete trailing line only: keep offset unless we skipped past an oversized single line.
        if (droppedLeadingPartial) state.offset = startOffset + bytesRead;
        return [];
      }

      const completeChunk = slice.subarray(0, lastNewline);
      state.offset = startOffset + lastNewline + 1;

      const text = completeChunk.toString("utf8");
      const lines = text.split(/\r?\n/);
      const startIndex = droppedLeadingPartial && startOffset > 0 ? 1 : 0;

      const found: AutoCompactionCheckpoint[] = [];
      for (let i = startIndex; i < lines.length; i++) {
        const checkpoint = parseCheckpointLine(lines[i] ?? "");
        if (!checkpoint || state.seenSteps.has(checkpoint.stepIndex)) continue;
        rememberSeenStep(state, checkpoint.stepIndex);
        found.push(checkpoint);
      }
      return found;
    } catch {
      return [];
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  function handleInboundRequest(parsed: unknown): void {
    if (!parsed || typeof parsed !== "object") return;
    const record = parsed as Record<string, any>;
    const method = typeof record.method === "string" ? record.method : "";
    const threadId = typeof record.params?.threadId === "string" ? record.params.threadId : null;
    if (!threadId) return;

    if (method === "thread/stop" || method === "thread/discard") {
      threads.delete(threadId);
      return;
    }

    if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") {
      const { appDataDir } = resolveAntigravityLaunchProfile(parsed, home);
      const state = getOrCreateState(threadId, appDataDir);
      const providerThreadId = record.params?.providerThreadId;
      if (typeof providerThreadId === "string") {
        bindProviderThread(state, providerThreadId);
      }
      return;
    }

    if (method === "turn/start") {
      const state = threads.get(threadId);
      if (state?.manual?.open === null) state.manual = null;
      return;
    }

    if (method === "thread/compact") {
      const state = getOrCreateState(threadId);
      if (!state.manual) beginManualCompaction(state, null);
    }
  }

  function processStdoutLine(line: string): string {
    if (
      !line.includes('"thread/delta"') &&
      !line.includes('"thread/identity"') &&
      !line.includes('"session/replaced"')
    ) {
      return line;
    }
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return line;
    }
    return processStdoutMessage(message) ? JSON.stringify(message) : line;
  }

  function processStdoutMessage(message: any): boolean {
    const params = message?.params;
    if (
      (message?.method === "thread/identity" || message?.method === "session/replaced") &&
      typeof params?.threadId === "string" &&
      typeof params?.providerThreadId === "string"
    ) {
      const state = getOrCreateState(params.threadId);
      bindProviderThread(state, params.providerThreadId);
      return false;
    }
    if (message?.method !== "thread/delta" || typeof params?.threadId !== "string" || !Array.isArray(params.deltas)) {
      return false;
    }

    const threadId: string = params.threadId;
    const deltas: Record<string, any>[] = params.deltas;
    let state = threads.get(threadId);
    let hasTriggerDelta = false;
    let hasBridgeCompacted = false;
    let turnBoundary: Record<string, any> | undefined;
    let postUsedTokens: number | null = null;
    let manualClose: Record<string, any> | undefined;

    for (const delta of deltas) {
      if (!delta || typeof delta !== "object") continue;
      if (delta.kind === "thread.identity" && typeof delta.providerThreadId === "string") {
        state = getOrCreateState(threadId);
        bindProviderThread(state, delta.providerThreadId);
      } else if (delta.kind === "item.open") {
        const key = compactionItemKey(delta);
        if (key !== null) {
          state ??= getOrCreateState(threadId);
          if (state.manual?.open === null) state.manual.open = delta;
          else if (!state.manual?.open || compactionItemKey(state.manual.open) !== key) beginManualCompaction(state, delta);
        }
      } else if (delta.kind === "item.close" && state?.manual?.open) {
        if (compactionItemKey(delta) === compactionItemKey(state.manual.open)) manualClose = delta;
      } else if (delta.kind === "context.compacted") {
        hasBridgeCompacted = true;
      } else if (delta.kind === "contextWindow") {
        hasTriggerDelta = true;
        if (typeof delta.used === "number" && Number.isFinite(delta.used) && delta.used >= 0) {
          postUsedTokens = delta.used;
        }
      } else if (delta.kind === "turn.boundary") {
        hasTriggerDelta = true;
        turnBoundary = delta;
      }
    }

    if (!state) return false;

    const manual = state.manual;
    if (manual) {
      let addedClose = false;
      if (!manualClose && manual.open && turnBoundary) {
        // SDK 0.6.157 opens the compaction channel but can finish without an explicit close.
        const { key, item, presentation } = manual.open;
        const status = turnBoundary.status === "completed"
          ? (hasBridgeCompacted ? "completed" : "interrupted")
          : (turnBoundary.status === "failed" ? "failed" : "interrupted");
        manualClose = { kind: "item.close", key, item, presentation, status };
        const compactedIndex = deltas.findIndex(delta => delta?.kind === "context.compacted");
        deltas.splice(compactedIndex >= 0 ? compactedIndex : deltas.indexOf(turnBoundary), 0, manualClose);
        addedClose = true;
      }
      if (postUsedTokens !== null) manual.postUsedTokens = postUsedTokens;
      if (hasTriggerDelta || manualClose || hasBridgeCompacted) {
        manual.checkpoint = scanNewCheckpoints(state).at(-1) ?? manual.checkpoint;
      }
      if (manualClose || turnBoundary || (manual.open === null && hasBridgeCompacted)) state.manual = null;
      if (manualClose?.status !== "completed" || !state.transcriptPath) return addedClose;
      if (manual.checkpoint) {
        const detail = formatCompactionDetail(manual.checkpoint, manual.postUsedTokens);
        if (detail === undefined) return addedClose;
        manualClose.presentation = { ...manualClose.presentation, detail };
        return true;
      }
      manualClose.status = "failed";
      manualClose.presentation = { ...manualClose.presentation, detail: MISSING_CHECKPOINT };
      params.deltas = deltas.filter(delta => delta?.kind !== "context.compacted").map(delta =>
        delta?.kind === "turn.boundary" && delta.status === "completed"
          ? { ...delta, status: "failed", error: { message: MISSING_CHECKPOINT } }
          : delta,
      );
      return true;
    }

    if (hasBridgeCompacted) {
      scanNewCheckpoints(state);
      return false;
    }

    if (!hasTriggerDelta || !state.transcriptPath) return false;

    const checkpoints = scanNewCheckpoints(state);
    if (checkpoints.length === 0) return false;

    const injected = checkpoints.flatMap(cp => buildAutoCompactionDeltas(cp, postUsedTokens));
    params.deltas = [...injected, ...deltas];
    return true;
  }

  function dispose(): void {
    threads.clear();
  }

  return {
    handleInboundRequest,
    processStdoutLine,
    processStdoutMessage,
    dispose,
  };
}
