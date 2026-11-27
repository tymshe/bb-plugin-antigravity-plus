import { openSync, closeSync, fstatSync, readSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import {
  commandOutputText, extractEventOutputText, inferAntigravityToolName, isValidBackgroundTaskId, normalizeFileUri, parseAntigravityCommandOutput,
  classifyManageTaskStatus, CLI_CANCELLATION, containsTaskToken, parseBackgroundCommandOutput,
  parseSubagentList, parseTaskAnnouncements, structuredCommandExitCode, subagentConversationId,
} from './dialect.ts';

export { normalizeFileUri };

export interface RecordedToolEvent {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  content?: unknown;
}
export interface BackgroundTask {
  taskId: string;
  taskType: 'local_bash' | 'local_subagent';
  description: string;
  parentToolCallId: string;
  outputFile?: string;
  transcriptPath?: string;
  /** Epoch ms when the task was registered; internal, used only for the persisted state file. */
  startedAt?: number;
  /** Synthetic task for a `run_command` call the CLI left running when its prompt ended. */
  orphan?: boolean;
}
/** Durable record persisted for each registered background task so state survives host restarts. */
export interface PersistedBackgroundTask {
  threadId: string;
  taskId: string;
  taskType: BackgroundTask['taskType'];
  description: string;
  parentToolCallId: string;
  transcriptPath?: string;
  outputFile?: string;
  startedAt: number;
}
interface PersistedBackgroundTaskStateFile {
  version: 1;
  tasks: PersistedBackgroundTask[];
}
export interface BackgroundTaskDelta {
  kind: 'item.open' | 'item.close';
  attach?: 'currentOrLast';
  key: { providerItemId: string; parentRef?: string };
  status?: 'completed' | 'failed' | 'interrupted';
  item: Record<string, unknown>;
  presentation: Record<string, unknown>;
}
export interface SilentTurnInjectionDelta {
  kind: 'item.textDelta' | 'item.textClose';
  key: { channel: string };
  channel: 'agentMessage';
  text: string;
}
export type TrackerDelta = BackgroundTaskDelta | SilentTurnInjectionDelta;
const TERMINAL_TOOL_STATUS = /^(?:completed|failed|cancell?ed)$/i;
// After this many consecutive silent turns (failed empty-output command, no agent text),
// the injected message escalates to "command execution appears broken in this session".
export const SILENT_TURN_ESCALATION_THRESHOLD = 2;
export function deriveTranscriptPathFromLogFile(outputFile: string): string | null {
  const path = normalizeFileUri(outputFile).replace(/\\/g, '/');
  return /\/\.system_generated\/tasks\/[^/]+$/.test(path)
    ? path.replace(/\.system_generated\/tasks\/[^/]+$/, '.system_generated/logs/transcript.jsonl') : null;
}
export function extractToolOutputText(event: RecordedToolEvent): string {
  function extract(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(extract).filter(Boolean).join('\n');
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const parts = ['text', 'content', 'output'].filter(key => key in obj).map(key => extract(obj[key]));
      return parts.length ? parts.join('\n') : JSON.stringify(value);
    }
    return '';
  }
  return [extract(event.content), extract(event.rawOutput)].filter(Boolean).join('\n');
}
const first = (...values: unknown[]): string => values.find(v => typeof v === 'string' && v.trim())?.toString().trim() ?? '';
function mergeToolEvent(previous: RecordedToolEvent | undefined, event: RecordedToolEvent): RecordedToolEvent {
  return {
    ...previous, ...event,
    title: event.title ?? previous?.title,
    kind: event.kind ?? previous?.kind,
    status: event.status ?? previous?.status,
    rawInput: previous?.rawInput && event.rawInput ? { ...previous.rawInput, ...event.rawInput } : event.rawInput ?? previous?.rawInput,
    rawOutput: event.rawOutput ?? previous?.rawOutput,
    content: event.content ?? previous?.content,
  };
}

/**
 * Default maximum age of a persisted record before it is garbage-collected (a running task is
 * never expected to outlive this). Configurable per tracker via `taskStateMaxAgeMs`.
 */
const DEFAULT_TASK_STATE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const STATE_LOCK_STALE_MS = 5_000;
const STATE_LOCK_WAIT_BUDGET_MS = 150;
const DEFAULT_MAX_TRANSCRIPT_READ_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_CHUNKS_PER_POLL = 4;
const MAX_TRANSCRIPT_PARTIAL_BYTES = 256 * 1024;
const MAX_RETAINED_TOOLS_PER_THREAD = 128;
const MAX_PENDING_TOOL_EVENTS = 512;
const MAX_PENDING_EVENTS_PER_TOOL = 32;
const TRANSCRIPT_HEAD_CHARS = 16 * 1024;
const MAX_ORPHAN_SUMMARY_CHARS = 4096;

function boundTranscriptLine(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_PARTIAL_BYTES) return text;
  const gap = ' … ';
  return text.slice(0, TRANSCRIPT_HEAD_CHARS) + gap +
    text.slice(-(MAX_TRANSCRIPT_PARTIAL_BYTES - TRANSCRIPT_HEAD_CHARS - gap.length));
}
const MAX_STREAM_BUFFER_CHARS = 64 * 1024;
const LOCK_SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

export function defaultBackgroundTaskStatePath(): string {
  const override = process.env.BB_ANTIGRAVITY_TASK_STATE_DIR?.trim();
  const dir = override || join(homedir(), '.bb', 'plugin-data', 'bb-plugin-antigravity-plus');
  return join(dir, 'background-tasks.json');
}

/** Loads and validates the state file. Missing or corrupt files degrade to an empty list. */
function readTaskState(path: string, maxAgeMs: number): {
  records: PersistedBackgroundTask[];
  pruned: boolean;
} {
  const empty = { records: [], pruned: false };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { return empty; }
  if (!parsed || typeof parsed !== 'object') return empty;
  const file = parsed as { version?: unknown; tasks?: unknown };
  if (file.version !== 1 || !Array.isArray(file.tasks)) return empty;
  const cutoff = Date.now() - Math.max(0, maxAgeMs); // Garbage-collect stale records.
  const records: PersistedBackgroundTask[] = [];
  for (const entry of file.tasks) {
    if (!entry || typeof entry !== 'object') continue;
    const task = entry as Partial<PersistedBackgroundTask>;
    if (typeof task.threadId !== 'string' || typeof task.taskId !== 'string' || typeof task.description !== 'string' ||
        typeof task.parentToolCallId !== 'string' || typeof task.startedAt !== 'number' ||
        !Number.isFinite(task.startedAt) ||
        (task.taskType !== 'local_bash' && task.taskType !== 'local_subagent')) continue;
    // Legacy IDs must survive startup GC until BB can close the original banner.
    if (task.startedAt < cutoff && isValidBackgroundTaskId(task.taskId)) continue;
    records.push({
      threadId: task.threadId, taskId: task.taskId, taskType: task.taskType, description: task.description,
      parentToolCallId: task.parentToolCallId, startedAt: task.startedAt,
      ...(typeof task.transcriptPath === 'string' ? { transcriptPath: task.transcriptPath } : {}),
      ...(typeof task.outputFile === 'string' ? { outputFile: task.outputFile } : {}),
    });
  }
  return { records, pruned: records.length < file.tasks.length };
}

/** Coordinates concurrent host writers on the same machine via an atomic O_EXCL lockfile. */
function withTaskStateLock(path: string, fn: () => boolean): boolean {
  const lockPath = `${path}.lock`;
  let lockFd: number | undefined;
  const deadline = performance.now() + STATE_LOCK_WAIT_BUDGET_MS;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return false;
  }
  for (;;) {
    try {
      lockFd = openSync(lockPath, 'wx');
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') return false;
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STATE_LOCK_STALE_MS) {
          try { unlinkSync(lockPath); } catch { /* raced with another cleaner */ }
          continue;
        }
      } catch {
        continue;
      }
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) return false;
      Atomics.wait(LOCK_SLEEP_ARRAY, 0, 0, Math.min(10, remaining));
    }
  }
  try {
    return fn();
  } finally {
    try { closeSync(lockFd); } catch { /* ignore */ }
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

/** Atomic-ish write: temp file + rename, so a crash mid-write can never corrupt the state file. */
function writeTaskState(path: string, tasks: PersistedBackgroundTask[]): boolean {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${JSON.stringify({ version: 1, tasks } satisfies PersistedBackgroundTaskStateFile)}\n`);
    renameSync(temp, path);
    return true;
  } catch {
    try { unlinkSync(temp); } catch { /* Best effort. */ }
    // Best effort: persistence trouble (missing dir permissions, full disk, ...) must never
    // crash the plugin host. Keep pending changes for the next save.
    return false;
  }
}

export function createBackgroundTaskTracker(options: {
  pollIntervalMs?: number;
  onAsyncDeltas?: (threadId: string, deltas: BackgroundTaskDelta[]) => void;
  /** Path of the persisted state file; omit to keep tracking in memory only (used by tests and the dev harness). */
  persistPath?: string;
  taskStateMaxAgeMs?: number;
  maxTranscriptReadBytes?: number;
} = {}) {
  const threads = new Map<string, Map<string, BackgroundTask>>();
  const pending = new Map<string, RecordedToolEvent[]>();
  const threadTools = new Map<string, Map<string, RecordedToolEvent>>();
  const streamBuffers = new Map<string, string>();
  const watchers = new Map<string, Map<string, { offset: number; partial: string; decoder: StringDecoder }>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  const interval = options.pollIntervalMs ?? 500;
  const persistPath = options.persistPath || undefined;
  const maxAge = options.taskStateMaxAgeMs ?? DEFAULT_TASK_STATE_MAX_AGE_MS;
  const maxReadBytes = Math.max(1024, options.maxTranscriptReadBytes ?? DEFAULT_MAX_TRANSCRIPT_READ_BYTES);
  const taskKey = (task: Pick<BackgroundTask, 'taskType' | 'taskId'>) => `${task.taskType === 'local_subagent' ? 'subagent' : 'task'}:${task.taskId}`;
  // Silent-turn detection state (issue: turn ends with no agent message after a failed
  // command with empty output, so BB records "No final output was recorded").
  const silentTurns = new Map<string, { agentText: boolean; emptyFailedCommand: boolean; streak: number }>();
  function silentState(thread: string): { agentText: boolean; emptyFailedCommand: boolean; streak: number } {
    let state = silentTurns.get(thread);
    if (!state) {
      state = { agentText: false, emptyFailedCommand: false, streak: 0 };
      silentTurns.set(thread, state);
    }
    return state;
  }
  function silentTurnMessage(streak: number): string {
    if (streak >= SILENT_TURN_ESCALATION_THRESHOLD) {
      return `Command execution appears broken in this session: ${streak} consecutive turns ended without an agent response after commands failed with empty output. Restart the thread runtime (reload the thread) or restart the host.`;
    }
    return 'The Antigravity agent ended this turn without a response after a command failed with empty output. Command execution may be broken in the CLI runtime — try reloading the thread or restarting the host.';
  }
  // Injected warnings reuse the exact wire shape the SDK's ACP bridge uses for genuine agent
  // messages: an `item.textDelta` + `item.textClose` pair on the assistant stream key
  // (`key.channel: "assistant"`, `channel: "agentMessage"`). The host delta assembler
  // auto-opens an `agentMessage` item on the first textDelta and settles it on the textClose,
  // recording the text as the turn's agent output. The pair must be inserted *before* the
  // `turn.boundary` entry in the delta list: after the boundary the host closes the turn,
  // and any text delta appended past it would be dropped instead of recorded.
  function silentTurnInjection(text: string): SilentTurnInjectionDelta[] {
    return [
      { kind: 'item.textDelta', key: { channel: 'assistant' }, channel: 'agentMessage', text },
      { kind: 'item.textClose', key: { channel: 'assistant' }, channel: 'agentMessage', text },
    ];
  }
  function handleTurnBoundary(thread: string, status: unknown): string | null {
    const state = silentState(thread);
    const silent = !state.agentText && state.emptyFailedCommand;
    let message: string | null = null;
    if (status === 'completed' && silent) {
      state.streak += 1;
      message = silentTurnMessage(state.streak);
    } else if (!silent) {
      // Any turn that emitted agent text or had no such failure resets the streak.
      state.streak = 0;
    }
    // Interrupted/failed boundaries with the silent pattern are ambiguous (e.g. the user
    // stopped the turn): leave the streak untouched so a later confirmed silent turn escalates.
    state.agentText = false;
    state.emptyFailedCommand = false;
    return message;
  }
  function delta(task: BackgroundTask, status?: BackgroundTaskDelta['status'], taskStatus?: string, summary?: string): BackgroundTaskDelta {
    const agent = task.taskType === 'local_subagent';
    return {
      kind: status ? 'item.close' : 'item.open',
      ...(status ? { status } : { attach: 'currentOrLast' as const }),
      key: { providerItemId: taskKey(task), ...(task.parentToolCallId ? { parentRef: task.parentToolCallId } : {}) },
      item: { type: 'backgroundTask', familyId: task.taskId, taskType: task.taskType, description: task.description,
        status: status ?? 'pending', taskStatus: taskStatus ?? 'running', skipTranscript: false, foreground: false,
        ...(task.outputFile ? { outputFile: task.outputFile } : {}), ...(summary ? { summary } : {}) },
      presentation: { label: { pending: `Running background ${agent ? 'agent' : 'command'}`, completed: `Background ${agent ? 'agent' : 'command'} finished` },
        icon: { glyph: agent ? 'Bot' : 'Terminal' }, title: task.description },
    };
  }
  const toRecord = (thread: string, task: BackgroundTask): PersistedBackgroundTask => ({
    threadId: thread, taskId: task.taskId, taskType: task.taskType, description: task.description,
    parentToolCallId: task.parentToolCallId, startedAt: task.startedAt ?? Date.now(),
    ...(task.transcriptPath ? { transcriptPath: task.transcriptPath } : {}),
    ...(task.outputFile ? { outputFile: task.outputFile } : {}),
  });
  const recordKey = (record: PersistedBackgroundTask) => JSON.stringify([record.threadId, taskKey(record)]);
  const pendingWrites = new Map<string, { record: PersistedBackgroundTask; remove: boolean }>();
  function persistTasks(thread: string, tasks: BackgroundTask[], remove: boolean) {
    if (!persistPath) return;
    for (const task of tasks) {
      const record = toRecord(thread, task);
      const key = recordKey(record);
      pendingWrites.set(JSON.stringify([key, record.startedAt, record.parentToolCallId]), { record, remove });
      initialRecords.delete(key);
    }
    flushPendingWrites();
  }
  function flushPendingWrites() {
    if (!persistPath || !pendingWrites.size) return;
    const saved = withTaskStateLock(persistPath, () => {
      const records = new Map(readTaskState(persistPath, maxAge).records.map(record => [recordKey(record), record]));
      for (const change of pendingWrites.values()) {
        const key = recordKey(change.record);
        const existing = records.get(key);
        if (change.remove) {
          if (existing?.startedAt === change.record.startedAt && existing.parentToolCallId === change.record.parentToolCallId) {
            records.delete(key);
          }
        } else {
          // Preserve newer replacements and same-millisecond replacements from another tool call.
          if (
            existing &&
            (existing.startedAt > change.record.startedAt ||
              (existing.startedAt === change.record.startedAt &&
                existing.parentToolCallId !== change.record.parentToolCallId))
          ) {
            continue;
          }
          records.set(key, change.record);
        }
      }
      const sorted = [...records.values()].sort((a, b) =>
        a.threadId === b.threadId ? a.taskId.localeCompare(b.taskId) : a.threadId.localeCompare(b.threadId),
      );
      return writeTaskState(persistPath, sorted);
    });
    if (saved) pendingWrites.clear();
  }
  /**
   * Restart reconciliation: `clearThread`-shaped `interrupted` closes for persisted tasks of a
   * resumed thread that were never settled in this process, then drops those records so BB and
   * the resumed agent learn the tasks died with the previous host.
   */
  function reconcilePersisted(thread: string): BackgroundTaskDelta[] {
    if (!persistPath) return [];
    const { records } = readTaskState(persistPath, maxAge);
    const active = threads.get(thread);
    const pendingReconcile = records.filter(record => {
      const initial = initialRecords.get(recordKey(record));
      return record.threadId === thread && !active?.has(taskKey(record)) &&
        (!isValidBackgroundTaskId(record.taskId) ||
          (initial?.startedAt === record.startedAt && initial.parentToolCallId === record.parentToolCallId));
    });
    if (!pendingReconcile.length) return [];
    const results = pendingReconcile.map(record => delta({
      taskId: record.taskId, taskType: record.taskType, description: record.description, parentToolCallId: record.parentToolCallId,
      ...(record.transcriptPath ? { transcriptPath: record.transcriptPath } : {}), ...(record.outputFile ? { outputFile: record.outputFile } : {}),
    }, 'interrupted', 'stopped'));
    persistTasks(thread, pendingReconcile, true);
    return results;
  }
  function syncPolling() {
    for (const [thread, paths] of watchers) {
      for (const path of paths.keys()) {
        if (![...(threads.get(thread)?.values() ?? [])].some(t => t.transcriptPath === path)) paths.delete(path);
      }
      if (!paths.size) watchers.delete(thread);
    }
    if (!watchers.size && timer) { clearInterval(timer); timer = undefined; }
  }
  function settle(thread: string, id: string, status: NonNullable<BackgroundTaskDelta['status']>, taskStatus: string, summary?: string, type?: BackgroundTask['taskType']) {
    const tasks = threads.get(thread);
    const removed: BackgroundTask[] = [];
    const results: BackgroundTaskDelta[] = [];
    for (const [key, task] of tasks ?? []) {
      if ((task.taskId === id || task.taskId.endsWith(`/${id}`) || id.endsWith(`/${task.taskId}`)) && (!type || task.taskType === type)) {
        tasks!.delete(key);
        removed.push(task);
        results.push(delta(task, status, taskStatus, summary));
      }
    }
    if (!tasks?.size) threads.delete(thread);
    syncPolling();
    if (removed.length) persistTasks(thread, removed, true);
    return results;
  }
  function inspectTextForCompletions(thread: string, text: string): BackgroundTaskDelta[] {
    return parseTaskAnnouncements(text).flatMap(({ id, type, status, summary }) =>
      settle(thread, id, status, status === 'interrupted' ? 'killed' : status, summary, type));
  }
  function poll() {
    for (const [thread, paths] of watchers) for (const [path, state] of paths) {
      let fd: number | undefined;
      let text = '';
      try {
        fd = openSync(path, 'r');
        const size = fstatSync(fd).size;
        if (size < state.offset) { state.offset = 0; state.partial = ''; state.decoder = new StringDecoder('utf8'); }
        for (let chunk = 0; chunk < MAX_TRANSCRIPT_CHUNKS_PER_POLL && size > state.offset; chunk += 1) {
          const toRead = Math.min(size - state.offset, maxReadBytes);
          const buffer = Buffer.allocUnsafe(toRead);
          const count = readSync(fd, buffer, 0, toRead, state.offset);
          if (count <= 0) break;
          state.offset += count;
          const appended = state.partial + state.decoder.write(buffer.subarray(0, count));
          const end = appended.lastIndexOf('\n');
          state.partial = boundTranscriptLine(appended.slice(end + 1));
          if (end !== -1) text += appended.slice(0, end + 1);
        }
      } catch { /* The CLI may not have created the transcript yet. */ }
      finally { if (fd !== undefined) closeSync(fd); }
      if (text) {
        const deltas = text.split('\n').flatMap(line => {
          const bounded = boundTranscriptLine(line);
          let message: string;
          try {
            const record: unknown = JSON.parse(bounded);
            if (typeof record === 'string') {
              message = record;
            } else {
              if (!record || typeof record !== 'object') return [];
              const isToolOutput = ['type', 'role', 'source'].some(field => {
                const value: unknown = Reflect.get(record, field);
                return typeof value === 'string' && /^(?:tool|command)(?:$|[_./-])/i.test(value);
              });
              if (isToolOutput) return [];
              const fields = ['text', 'content', 'message'].map(key => Reflect.get(record, key));
              message = extractToolOutputText({ toolCallId: '', content: fields });
            }
          } catch {
            message = bounded.startsWith('{') && bounded.includes(' … ')
              ? bounded.replace(/^\{\s*"[^"]+"\s*:\s*"/, '').replace(/\\"/g, '"')
              : bounded;
          }
          return inspectTextForCompletions(thread, message);
        });
        if (deltas.length) options.onAsyncDeltas?.(thread, deltas);
      }
    }
  }
  function handleToolEventForThread(thread: string, event: RecordedToolEvent): BackgroundTaskDelta[] {
    if (disposed) return [];
    // A failed run_command event with empty/whitespace output is the exact signature of the
    // "silent give-up" turn: record it even though no background task is registered for it.
    if (event.status === 'failed') {
      const inferred = inferAntigravityToolName(event as any);
      const name = inferred ?? [event.title, event.kind].find(v => typeof v === 'string' && v.trim()) ?? '';
      if (name === 'run_command' && !extractToolOutputText(event).trim()) {
        silentState(thread).emptyFailedCommand = true;
      }
    }
    if (event.status !== 'completed') return [];
    const input = event.rawInput ?? {};
    const inferred = inferAntigravityToolName(event as any);
    const name = (inferred && /^(run_command|schedule|invoke_subagent|manage_task|manage_subagents)$/.test(inferred) ? inferred : undefined)
      ?? [event.title, event.kind].find(v => /^(run_command|schedule|invoke_subagent|manage_task|manage_subagents)$/.test(v ?? '')) ?? '';
    const command = name === 'run_command' || name === 'schedule';
    const text = command ? commandOutputText(event) : extractToolOutputText(event);
    const action = String(input.Action ?? '').toLowerCase();
    const results: BackgroundTaskDelta[] = [];
    if (name === 'manage_task') {
      const id = first(input.TaskId);
      if (action === 'kill' && id) return settle(thread, id, 'interrupted', 'killed', text, 'local_bash');
      if (action === 'status' && id) {
        const status = classifyManageTaskStatus(text, event.rawOutput);
        if (status) return settle(thread, id, status, status === 'interrupted' ? 'killed' : status, text, 'local_bash');
      }
      if (action === 'list' && /No running tasks|\| Start Time \| Task ID \| Tool \| Description \|/i.test(text)) {
        for (const task of getActiveTasks(thread)) {
          const present = containsTaskToken(text, task.taskId) || containsTaskToken(text, task.taskId.split('/').pop()!);
          if (task.taskType === 'local_bash' && !task.orphan && !present) results.push(...settle(thread, task.taskId, 'completed', 'completed', text, task.taskType));
        }
      }
    }
    if (name === 'manage_subagents') {
      const isFinished = parseSubagentList(event.rawOutput, text);
      for (const task of getActiveTasks(thread)) {
        if (task.taskType !== 'local_subagent') continue;
        const kill = action === 'kill_all' || (action === 'kill' && Array.isArray(input.ConversationIds) && input.ConversationIds.includes(task.taskId));
        if (kill || (action === 'list' && isFinished(task.taskId))) results.push(...settle(thread, task.taskId, kill ? 'interrupted' : 'completed', kill ? 'killed' : 'completed', text, task.taskType));
      }
    }
    const agent = name === 'invoke_subagent';
    const parsedCommand = command ? parseBackgroundCommandOutput(event, text) : null;
    const id = agent ? subagentConversationId(event.rawOutput, text) : parsedCommand?.taskId;
    if (!id) return results;
    const title = /^(run_command|schedule|invoke_subagent)$/.test(event.title ?? '') ? '' : event.title;
    const outputFile = parsedCommand?.outputFile ?? '';
    const task: BackgroundTask = { taskId: id, taskType: agent ? 'local_subagent' : 'local_bash', parentToolCallId: event.toolCallId,
      description: agent ? first(input.Role, input.TypeName, title, id) : first(input.toolSummary, parsedCommand?.description, input.CommandLine, input.command, input.Prompt, title, id),
      ...(outputFile ? { outputFile, transcriptPath: deriveTranscriptPathFromLogFile(outputFile) ?? undefined } : {}), startedAt: Date.now() };
    return [...results, ...registerTask(thread, task)];
  }
  function registerTask(thread: string, task: BackgroundTask): BackgroundTaskDelta[] {
    if (!isValidBackgroundTaskId(task.taskId)) return [];
    const tasks = threads.get(thread) ?? new Map<string, BackgroundTask>();
    if (tasks.has(taskKey(task))) return [];
    tasks.set(taskKey(task), task); threads.set(thread, tasks);
    persistTasks(thread, [task], false);
    if (task.transcriptPath && interval > 0) {
      const paths = watchers.get(thread) ?? new Map();
      if (!paths.has(task.transcriptPath)) {
        let offset = 0;
        try { offset = statSync(task.transcriptPath).size; } catch { /* Start at zero when the file appears. */ }
        paths.set(task.transcriptPath, { offset, partial: '', decoder: new StringDecoder('utf8') });
      }
      watchers.set(thread, paths);
      if (!timer) { timer = setInterval(poll, interval); timer.unref(); }
    }
    return [delta(task)];
  }
  /**
   * The CLI can end its prompt while a `run_command` call is still `in_progress`. The SDK bridge
   * then force-closes the item (status `completed`, no output, no `noTurnFallback`) although the
   * command keeps running, and the real result only arrives as a `tool_call_update` after the
   * turn boundary. Track such a call as a background task that the late result settles.
   */
  function registerOrphanCommand(thread: string, event: RecordedToolEvent): BackgroundTaskDelta[] {
    const name = inferAntigravityToolName(event as any) ?? [event.title, event.kind].find(v => v === 'run_command');
    if (name !== 'run_command') return [];
    const input = event.rawInput ?? {};
    return registerTask(thread, {
      taskId: event.toolCallId, taskType: 'local_bash', parentToolCallId: event.toolCallId,
      description: first(input.toolSummary, input.CommandLine, input.command, event.title, event.toolCallId),
      startedAt: Date.now(), orphan: true,
    });
  }
  function settleOrphanCommand(thread: string, event: RecordedToolEvent): BackgroundTaskDelta[] {
    const task = threads.get(thread)?.get(taskKey({ taskType: 'local_bash', taskId: event.toolCallId }));
    if (!task?.orphan || !TERMINAL_TOOL_STATUS.test(event.status ?? '')) return [];
    const rawText = extractEventOutputText({ rawOutput: event.rawOutput });
    const contentText = extractEventOutputText({ content: event.content });
    const rawResult = parseAntigravityCommandOutput(rawText);
    const contentResult = parseAntigravityCommandOutput(contentText);
    const code = structuredCommandExitCode(event.rawOutput) ?? rawResult.exitCode ?? contentResult.exitCode;
    const killed = /cancel/i.test(event.status ?? '') || CLI_CANCELLATION.test(rawText) || CLI_CANCELLATION.test(contentText);
    const failed = code !== null ? code !== 0 : event.status === 'failed';
    const summary = (rawResult.cleanOutput.trim() || contentResult.cleanOutput.trim()).slice(0, MAX_ORPHAN_SUMMARY_CHARS);
    return settle(thread, task.taskId, killed ? 'interrupted' : failed ? 'failed' : 'completed',
      killed ? 'killed' : failed ? 'failed' : 'completed', summary || undefined, 'local_bash');
  }

  function evictOldestRetainedTool(thread: string, tools: Map<string, RecordedToolEvent>) {
    const activeTasks = threads.get(thread);
    for (const key of tools.keys()) {
      if (activeTasks?.has(taskKey({ taskType: 'local_bash', taskId: key }))) continue;
      tools.delete(key);
      return;
    }
  }
  function getActiveTasks(thread: string): ReadonlyArray<BackgroundTask> { return [...(threads.get(thread)?.values() ?? [])].map(task => ({ ...task })); }
  function clearThread(thread: string, emitCloseDeltas = false): BackgroundTaskDelta[] {
    const active = getActiveTasks(thread);
    const results = emitCloseDeltas ? active.map(task => delta(task, 'interrupted', 'stopped')) : [];
    threads.delete(thread); threadTools.delete(thread); streamBuffers.delete(thread); silentTurns.delete(thread); syncPolling();
    const recovered = [...initialRecords.values()].filter(record => record.threadId === thread);
    persistTasks(thread, [...recovered, ...active], true);
    return results;
  }
  function handleInboundRequest(request: unknown): BackgroundTaskDelta[] {
    const message = request as { method?: string; params?: { threadId?: string } } | null;
    if (!message || typeof message.params?.threadId !== 'string') return [];
    const thread = message.params.threadId;
    const method = message.method ?? '';
    if (method === 'thread/stop' || method === 'thread/discard') return [...reconcilePersisted(thread), ...clearThread(thread, true)];
    if (method === 'thread/resume' || method === 'turn/start' || method === 'thread/compact') return reconcilePersisted(thread);
    return [];
  }
  // Startup load: snapshot which records predate this host process (only those are eligible for
  // reconciliation) and flush a GC pass so records older than the max age cannot accumulate
  // across restarts, even if no traffic ever arrives. Persisted records are intentionally NOT
  // dropped on dispose(): a graceful host exit is indistinguishable from a crash here, and the
  // next resume must still report the tasks as interrupted.
  const initialRecords = new Map<string, PersistedBackgroundTask>();
  if (persistPath) {
    const { records, pruned } = readTaskState(persistPath, maxAge);
    let initial = records;
    if (pruned) {
      withTaskStateLock(persistPath, () => {
        const current = readTaskState(persistPath, maxAge);
        initial = current.records;
        return !current.pruned || writeTaskState(persistPath, current.records);
      });
    }
    for (const record of initial) initialRecords.set(recordKey(record), record);
  }
  function processStdoutMessage(message: any): boolean {
    const params = message?.params;
    if (message?.method !== 'thread/delta' || typeof params?.threadId !== 'string' || !Array.isArray(params.deltas)) return false;
    const extra: BackgroundTaskDelta[] = [];
    // Injected silent-turn warnings must precede the turn boundary in the delta list
    // (after the boundary the host has already closed the turn and would drop them),
    // so the outgoing deltas are rebuilt instead of blindly appended.
    const ordered: unknown[] = [];
    let boundarySeen = false;
    const warned = params.deltas.some((entry: unknown) => entry && typeof entry === 'object' && 'kind' in entry && entry.kind === 'provider.warning');
    for (const entry of params.deltas) {
      const update = entry?.noTurnFallback?.raw?.params?.update;
      const id = entry?.key?.providerItemId ?? update?.toolCallId;
      if (typeof id === 'string') {
        const queue = pending.get(id);
        const queued = queue?.shift();
        if (!queue?.length) pending.delete(id);
        // The fallback update belongs to this exact thread; prefer it over the unscoped hook.
        const event = update && typeof update === 'object' ? { ...update, toolCallId: id } as RecordedToolEvent : queued;
        const tools = threadTools.get(params.threadId) ?? new Map<string, RecordedToolEvent>();
        const known = tools.get(id);
        const merged = event ? mergeToolEvent(known, event) : known;
        if (event) {
          if (!tools.has(id) && tools.size >= MAX_RETAINED_TOOLS_PER_THREAD) {
            evictOldestRetainedTool(params.threadId, tools);
          }
          tools.set(id, merged!);
          threadTools.set(params.threadId, tools);
        }
        if (!warned && merged && entry?.kind === 'item.close' && !entry.noTurnFallback && entry.status === 'completed' && !TERMINAL_TOOL_STATUS.test(merged.status ?? '')) {
          // The bridge flushed a call the CLI never finished (prompt ended mid-command).
          extra.push(...registerOrphanCommand(params.threadId, merged));
        } else if (event && merged && (TERMINAL_TOOL_STATUS.test(merged.status ?? '') || entry?.kind === 'item.close')) {
          extra.push(...settleOrphanCommand(params.threadId, merged));
          extra.push(...handleToolEventForThread(params.threadId, merged));
          // Drop large tool output/content once processed while keeping compact input metadata for late updates.
          tools.set(id, {
            toolCallId: merged.toolCallId,
            ...(merged.title !== undefined ? { title: merged.title } : {}),
            ...(merged.kind !== undefined ? { kind: merged.kind } : {}),
            ...(merged.status !== undefined ? { status: merged.status } : {}),
            ...(merged.rawInput !== undefined ? { rawInput: merged.rawInput } : {}),
          });
        }
      }
      const commandOutput = entry?.item?.type === 'command' || entry?.kind === 'command.outputSnapshot';
      if (entry?.kind === 'item.textDelta' && typeof entry.text === 'string') {
        const combined = (streamBuffers.get(params.threadId) ?? '') + entry.text;
        streamBuffers.set(
          params.threadId,
          combined.length > MAX_STREAM_BUFFER_CHARS ? combined.slice(-MAX_STREAM_BUFFER_CHARS) : combined,
        );
        // Visible agent text (not reasoning) marks the turn as non-silent.
        if (entry.text.trim() && entry.channel !== 'reasoningText' && entry.channel !== 'reasoningSummary') {
          silentState(params.threadId).agentText = true;
        }
      } else if (!commandOutput && typeof entry?.text === 'string') {
        extra.push(...inspectTextForCompletions(params.threadId, entry.text));
      }
      if (entry?.kind === 'item.textClose' || entry?.kind === 'turn.boundary') {
        const buffered = streamBuffers.get(params.threadId);
        streamBuffers.delete(params.threadId);
        if (buffered) extra.push(...inspectTextForCompletions(params.threadId, buffered));
      }
      if (entry?.kind === 'item.textClose' && typeof entry.text === 'string' && entry.text.trim() && entry.channel !== 'reasoningText' && entry.channel !== 'reasoningSummary') {
        silentState(params.threadId).agentText = true;
      }
      if (entry?.kind === 'item.open' && entry?.item?.type === 'agentMessage' && typeof entry.item.text === 'string' && entry.item.text.trim()) {
        silentState(params.threadId).agentText = true;
      }
      if (entry?.kind === 'item.close' && entry?.status === 'failed' && (entry?.item?.type === 'command' || entry?.key?.channel === 'command')) {
        // Failed command item with empty/whitespace-only output: the "silent give-up" signature.
        const outputs = [entry?.item?.aggregatedOutput, entry?.aggregatedOutput, entry?.resultText];
        if (outputs.every(value => value == null || (typeof value === 'string' && value.trim() === ''))) {
          silentState(params.threadId).emptyFailedCommand = true;
        }
      }
      if (entry?.kind === 'turn.boundary' && !boundarySeen) {
        boundarySeen = true;
        const injectedText = handleTurnBoundary(params.threadId, entry?.status);
        if (typeof injectedText === 'string') ordered.push(...silentTurnInjection(injectedText));
      }
      ordered.push(entry);
      if (commandOutput) continue;
      for (const text of [entry?.resultText, entry?.aggregatedOutput, entry?.message, entry?.delta?.text, entry?.item?.output, entry?.item?.text]) {
        if (typeof text === 'string') extra.push(...inspectTextForCompletions(params.threadId, text));
      }
    }
    ordered.push(...extra);
    if (ordered.length === params.deltas.length) return false;
    params.deltas = ordered;
    return true;
  }
  return {
    recordToolEvent(event: RecordedToolEvent) {
      if (disposed) return;
      if (!pending.has(event.toolCallId) && pending.size >= MAX_PENDING_TOOL_EVENTS) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      const queue = pending.get(event.toolCallId) ?? [];
      if (queue.length >= MAX_PENDING_EVENTS_PER_TOOL) queue.shift();
      queue.push(event);
      pending.set(event.toolCallId, queue);
    },
    handleToolEventForThread, inspectTextForCompletions, getActiveTasks, clearThread,
    processStdoutMessage,
    processStdoutLine(line: string): string[] {
      let message: unknown;
      try { message = JSON.parse(line); } catch { return [line]; }
      return [processStdoutMessage(message) ? JSON.stringify(message) : line];
    },
    handleInboundRequest,
    dispose() {
      if (disposed) return;
      flushPendingWrites();
      disposed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      threads.clear();
      pending.clear();
      pendingWrites.clear();
      initialRecords.clear();
      threadTools.clear();
      streamBuffers.clear();
      silentTurns.clear();
      watchers.clear();
    },
  };
}
