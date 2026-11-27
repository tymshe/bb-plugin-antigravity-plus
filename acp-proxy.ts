/*
 * What: a line-delimited JSON-RPC proxy between bb's shared ACP bridge and `agy acp`.
 *
 * Why: the shared bridge cannot be changed from a plugin, and it talks to agy in ways
 * agy supports better natively. The first behaviour here: bb sends its thread and skill
 * instructions as a `<system_instructions>` text block at the top of the first prompt and
 * never again after a session is restored (get-bb/bb#7537). agy accepts a real system
 * prompt as `_meta.antigravity.systemPrompt.append` on session/new, session/load, and
 * session/resume (it ignores it on session/prompt), so the proxy lifts the block out of
 * the first prompt, applies it with a live session/resume, and re-injects it whenever the
 * bridge loads or resumes that session later.
 *
 * Second behaviour: session/fork. agy does not advertise it, so the proxy adds it to the
 * initialize result and implements it by copying the conversation (agy-fork.ts) and opening
 * the copy with session/resume. Only tip forks; bb's bridge supports nothing else for ACP.
 *
 * Third behaviour: compaction outcomes. bb compacts by prompting "/compact" and counts any
 * end_turn as success. A real agy compaction (1.5.14) ends with only a usage update. When the
 * model answers instead (agy passed "/compact" to it, as on a new session, with thoughts, tool
 * calls or chat text), the proxy adds a failed `compaction_update`, so bb shows a failure.
 *
 * Fourth behaviour. The proxy maps an executor-busy prompt error to the ACP session_busy
 * code and reason so the shared bridge can retry the prompt.
 *
 * Design notes:
 * - The host artifact doubles as the proxy executable: host.ts rewrites the agy launch
 *   spec to `node <host.mjs> --agy-acp-proxy <agy> acp ...` on the agent host, so nothing
 *   extra is installed. See `proxyAntigravityLaunchSpec` in cli.ts.
 * - Messages the proxy does not change are forwarded as the original line.
 * - Proxy-originated requests use string ids with a reserved prefix; the bridge uses its
 *   own ids, so responses are routed without collisions.
 * - While a proxy-originated request is in flight, client messages are queued, so the
 *   prompt and anything after it (cancel, config changes) keep their order.
 * - Instructions are persisted per agy session id so they survive bridge and bb restarts.
 * - Every failure falls back to the bridge's own behaviour (the original prompt).
 * - Always on; `BB_AGY_ACP_PROXY=0` (e.g. via `bb machine env`) is the troubleshooting off switch.
 *   cli.ts then skips the proxy, and a proxy started anyway only relays lines unchanged.
 *
 * Gotchas:
 * - Verified against agy 1.5.14: a live session/resume keeps model, thought_level and mode.
 * - Each proxy start prunes instruction files for its own app data directory. A file is
 *   eligible once it is a day old and its conversation is gone.
 * - The proxy never reads stdin until `run` is called, so importing this module starts nothing.
 * - agy's stderr is held until agy first answers (at most 5 s), so when a pre-1.5.0 CLI fails
 *   (it has no `acp` subcommand) the proxy's "run agy update" explanation leads the error bb shows.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { forkAgyConversation, resolveAgyAppDataDir, type SqliteDatabaseClass } from "./agy-fork.ts";

export const AGY_ACP_PROXY_FLAG = "--agy-acp-proxy";
export const AGY_ACP_PROXY_STATE_DIR_ENV = "BB_AGY_ACP_PROXY_STATE_DIR";
/** Troubleshooting switch: `0` connects bb to `agy acp` without the proxy's changes. */
export const AGY_ACP_PROXY_SWITCH_ENV = "BB_AGY_ACP_PROXY";

const INSTRUCTIONS_OPEN = "<system_instructions>";
const INSTRUCTIONS_CLOSE = "</system_instructions>";
const INTERNAL_ID_PREFIX = "bb-agy-acp-proxy:";
const ACP_SESSION_BUSY_ERROR_CODE = -32003;
const EXECUTOR_BUSY_PATTERN = /executor has not processed the previous input yet/i;

function isExecutorBusyError(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  if ("message" in record && typeof record.message === "string" && EXECUTOR_BUSY_PATTERN.test(record.message)) return true;
  if (!("data" in record)) return false;
  if (typeof record.data === "string" && EXECUTOR_BUSY_PATTERN.test(record.data)) return true;
  if (record.data && typeof record.data === "object") {
    try {
      return EXECUTOR_BUSY_PATTERN.test(JSON.stringify(record.data));
    } catch {
      return false;
    }
  }
  return false;
}
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** `agy acp` first shipped in 1.5.0. */
export const MIN_AGY_ACP_VERSION = [1, 5, 0] as const;
const STDERR_HOLD_MS = 5_000;

type Json = Record<string, any>;

export interface InstructionStore {
  get(sessionId: string): string | undefined;
  set(sessionId: string, instructions: string): void;
}

/** Keeps instructions in memory and, when `dir` is set, in one JSON file per session. */
export function createInstructionStore(
  dir: string | undefined,
  appDataDir = resolveAgyAppDataDir([]),
  log: (message: string) => void = () => {},
): InstructionStore {
  const memory = new Map<string, string>();
  const fileFor = (sessionId: string) => (dir && SESSION_ID_PATTERN.test(sessionId) ? join(dir, `${sessionId}.json`) : undefined);
  return {
    get(sessionId) {
      if (memory.has(sessionId)) return memory.get(sessionId);
      const file = fileFor(sessionId);
      if (!file) return undefined;
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (parsed?.version === 1 && typeof parsed.instructions === "string") {
          memory.set(sessionId, parsed.instructions);
          return parsed.instructions;
        }
      } catch {}
      return undefined;
    },
    set(sessionId, instructions) {
      memory.set(sessionId, instructions);
      const file = fileFor(sessionId);
      if (!file || !dir) return;
      const temp = `${file}.${process.pid}.tmp`;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(temp, `${JSON.stringify({ version: 1, instructions, appDataDir })}\n`, { mode: 0o600 });
        renameSync(temp, file);
      } catch (error) {
        try { unlinkSync(temp); } catch { /* Best effort. */ }
        log(`could not persist instructions for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/**
 * Deletes stored instructions whose agy conversation is gone. Files younger than `minAgeMs` are
 * kept, so a session whose database is still being created is never touched. Best effort.
 */
export function pruneInstructionStore(dir: string, appDataDir: string, now = Date.now(), minAgeMs = 24 * 60 * 60 * 1000): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  const conversationsDir = join(appDataDir, "conversations");
  for (const name of names) {
    const sessionId = name.endsWith(".json") ? name.slice(0, -5) : undefined;
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) continue;
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs < minAgeMs) continue;
      if (existsSync(join(conversationsDir, `${sessionId}.db`))) continue;
      const record = JSON.parse(readFileSync(file, "utf8"));
      if (record?.version !== 1 || record.appDataDir !== appDataDir) continue;
      rmSync(file, { force: true });
      removed.push(sessionId);
    } catch {}
  }
  return removed;
}

/** Returns the instructions inside a bridge `<system_instructions>` block, or undefined. */
export function extractSystemInstructions(text: unknown): string | undefined {
  if (typeof text !== "string" || !text.startsWith(INSTRUCTIONS_OPEN)) return undefined;
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(INSTRUCTIONS_CLOSE)) return undefined;
  const inner = trimmed.slice(INSTRUCTIONS_OPEN.length, trimmed.length - INSTRUCTIONS_CLOSE.length);
  const instructions = inner.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return instructions.trim() ? instructions : undefined;
}

/** Adds an agy system-prompt append to `_meta`, leaving one the client already set. */
export function withSystemPrompt(meta: unknown, instructions: string): Json {
  const base: Json = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Json) : {};
  const antigravity: Json = base.antigravity && typeof base.antigravity === "object" ? base.antigravity : {};
  if (antigravity.systemPrompt?.append !== undefined) return base;
  return { ...base, antigravity: { ...antigravity, systemPrompt: { ...antigravity.systemPrompt, append: instructions } } };
}

const isRequest = (m: Json) => typeof m.method === "string" && m.id !== undefined && m.id !== null;
const isResponse = (m: Json) => m.method === undefined && m.id !== undefined && ("result" in m || "error" in m);

interface SessionContext { cwd: unknown; mcpServers: unknown }

export interface AgyAcpProxyOptions {
  toAgent(line: string): void;
  toClient(line: string): void;
  store: InstructionStore;
  /** Copies an agy conversation and returns the new id; when set, the proxy advertises session/fork. */
  fork?(sourceSessionId: string): string;
  log?(message: string): void;
}

export class AgyAcpProxy {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly newSessionRequests = new Map<unknown, SessionContext>();
  private readonly initializeRequests = new Set<unknown>();
  private nativeFork = false;
  private readonly compactions = new Map<unknown, { sessionId: string; text: string; modelActed: boolean }>();
  private readonly promptRequests = new Set<unknown>();
  private readonly internal = new Map<string, (response: Json) => void>();
  private readonly queue: string[] = [];
  private blocked = 0;
  private seq = 0;
  private readonly options: AgyAcpProxyOptions;

  constructor(options: AgyAcpProxyOptions) {
    this.options = options;
  }

  fromClient(line: string): void {
    if (this.blocked > 0) {
      this.queue.push(line);
      return;
    }
    const message = parse(line);
    if (!message) return this.options.toAgent(line);
    if (isRequest(message)) {
      const params: Json = message.params && typeof message.params === "object" ? message.params : {};
      switch (message.method) {
        case "initialize":
          if (this.options.fork) this.initializeRequests.add(message.id);
          break;
        case "session/new":
          this.newSessionRequests.set(message.id, { cwd: params.cwd, mcpServers: params.mcpServers });
          break;
        case "session/fork":
          if (this.options.fork && !this.nativeFork) return this.forkSession(message, params);
          break;
        case "session/load":
        case "session/resume":
          return this.options.toAgent(this.reapplyInstructions(message, params) ?? line);
        case "session/prompt":
          this.promptRequests.add(message.id);
          if (isCompactPrompt(params) && typeof params.sessionId === "string") {
            this.compactions.set(message.id, { sessionId: params.sessionId, text: "", modelActed: false });
          }
          if (this.liftInstructions(message, params, line)) return;
          break;
      }
    }
    this.options.toAgent(line);
  }

  fromAgent(line: string): void {
    const message = parse(line);
    if (message?.method === "session/update" && this.compactions.size > 0) this.recordCompactionText(message);
    if (message && isResponse(message)) {
      const callback = typeof message.id === "string" ? this.internal.get(message.id) : undefined;
      if (callback) {
        this.internal.delete(message.id);
        return callback(message);
      }
      const isPromptResponse = this.promptRequests.delete(message.id);
      const compaction = this.compactions.get(message.id);
      if (compaction) {
        this.compactions.delete(message.id);
        const reply = compaction.text.trim();
        if (compaction.modelActed && message.result?.stopReason === "end_turn") {
          const reason = reply
            ? `Antigravity did not compact the conversation: ${reply.slice(0, 500)}`
            : "Antigravity did not compact the conversation: the CLI passed /compact to the model instead of running it.";
          this.options.toClient(JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: compaction.sessionId,
              update: { sessionUpdate: "compaction_update", compactionId: `${INTERNAL_ID_PREFIX}compact-${++this.seq}`, status: "failed", error: reason },
            },
          }));
        }
      }
      if (isPromptResponse && message.error && isExecutorBusyError(message.error)) {
        const { data, message: errorMessage } = message.error;
        const existingData = data && typeof data === "object" && !Array.isArray(data) ? data : {};
        const details = typeof data === "string" ? data : existingData.details ?? errorMessage;
        return this.options.toClient(JSON.stringify({
          ...message,
          error: {
            ...message.error,
            code: ACP_SESSION_BUSY_ERROR_CODE,
            data: {
              ...existingData,
              ...(typeof details === "string" ? { details } : {}),
              reason: "session_busy",
            },
          },
        }));
      }
      if (this.initializeRequests.delete(message.id) && message.result) {
        if (message.result?.agentCapabilities?.sessionCapabilities?.fork !== undefined) {
          this.nativeFork = true;
          return this.options.toClient(line);
        }
        return this.options.toClient(JSON.stringify(advertiseFork(message)));
      }
      const context = this.newSessionRequests.get(message.id);
      if (context) {
        this.newSessionRequests.delete(message.id);
        const sessionId = message.result?.sessionId;
        if (typeof sessionId === "string") this.sessions.set(sessionId, context);
      }
    }
    this.options.toClient(line);
  }

  private recordCompactionText(message: Json): void {
    const update = message.params?.update;
    const kind = update?.sessionUpdate;
    if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk" && kind !== "tool_call") return;
    for (const compaction of this.compactions.values()) {
      if (compaction.sessionId !== message.params.sessionId) continue;
      compaction.modelActed = true;
      if (kind === "agent_message_chunk" && update.content?.type === "text") compaction.text += update.content.text ?? "";
    }
  }

  private reapplyInstructions(message: Json, params: Json): string | undefined {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string") return undefined;
    this.sessions.set(sessionId, { cwd: params.cwd, mcpServers: params.mcpServers });
    const instructions = this.options.store.get(sessionId);
    if (instructions === undefined) return undefined;
    return JSON.stringify({ ...message, params: { ...params, _meta: withSystemPrompt(params._meta, instructions) } });
  }

  private liftInstructions(message: Json, params: Json, line: string): boolean {
    const sessionId = params.sessionId;
    const prompt = params.prompt;
    if (typeof sessionId !== "string" || !Array.isArray(prompt) || prompt.length < 2) return false;
    const first = prompt[0];
    if (first?.type !== "text") return false;
    const instructions = extractSystemInstructions(first.text);
    const session = this.sessions.get(sessionId);
    if (instructions === undefined || !session) return false;
    this.options.store.set(sessionId, instructions);
    const stripped = JSON.stringify({ ...message, params: { ...params, prompt: prompt.slice(1) } });
    this.request("session/resume", {
      sessionId,
      cwd: session.cwd,
      mcpServers: Array.isArray(session.mcpServers) ? session.mcpServers : [],
      _meta: withSystemPrompt(undefined, instructions),
    }, response => {
      if (response.error) {
        this.options.log?.(`session/resume with system prompt failed; sending instructions in the prompt: ${JSON.stringify(response.error)}`);
        this.options.toAgent(line);
      } else {
        this.options.toAgent(stripped);
      }
    });
    return true;
  }

  /**
   * ACP session/fork at the tip: copy the agy conversation, carry its instructions over, and open
   * the copy with session/resume. bb may then close it here and resume it in the new thread's agy.
   */
  private forkSession(message: Json, params: Json): void {
    const reply = (body: Json) => this.options.toClient(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }));
    const sourceId = params.sessionId;
    if (typeof sourceId !== "string") {
      return reply({ error: { code: -32602, message: "session/fork needs a sessionId" } });
    }
    let forkedId: string;
    try {
      forkedId = this.options.fork!(sourceId);
    } catch (error) {
      return reply({ error: { code: -32603, message: `Could not fork the Antigravity conversation: ${error instanceof Error ? error.message : String(error)}` } });
    }
    const instructions = this.options.store.get(sourceId);
    if (instructions !== undefined) this.options.store.set(forkedId, instructions);
    const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
    this.sessions.set(forkedId, { cwd: params.cwd, mcpServers });
    const { sessionId: _source, _meta, ...rest } = params;
    this.request("session/resume", {
      ...rest,
      sessionId: forkedId,
      mcpServers,
      ...(instructions !== undefined ? { _meta: withSystemPrompt(_meta, instructions) } : _meta !== undefined ? { _meta } : {}),
    }, response => {
      if (response.error) {
        reply({ error: { code: -32603, message: `Forked the Antigravity conversation but could not open it: ${response.error.message ?? JSON.stringify(response.error)}` } });
      } else {
        reply({ result: { ...(response.result && typeof response.result === "object" ? response.result : {}), sessionId: forkedId } });
      }
    });
  }

  private request(method: string, params: Json, onResponse: (response: Json) => void): void {
    const id = `${INTERNAL_ID_PREFIX}${++this.seq}`;
    this.blocked++;
    this.internal.set(id, response => {
      onResponse(response);
      this.blocked--;
      this.drain();
    });
    this.options.toAgent(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  private drain(): void {
    while (this.blocked === 0 && this.queue.length > 0) this.fromClient(this.queue.shift()!);
  }
}

/** bb's compaction request: a prompt that is exactly "/compact". */
function isCompactPrompt(params: Json): boolean {
  const prompt = params.prompt;
  return Array.isArray(prompt) && prompt.length === 1 && prompt[0]?.type === "text" && String(prompt[0].text).trim() === "/compact";
}

/** Adds session/fork to an initialize result's session capabilities. */
export function advertiseFork(response: Json): Json {
  const result = response.result ?? {};
  const capabilities = result.agentCapabilities ?? {};
  if (capabilities.sessionCapabilities?.fork !== undefined) return response;
  const session = { ...(capabilities.sessionCapabilities ?? {}), fork: {} };
  return { ...response, result: { ...result, agentCapabilities: { ...capabilities, sessionCapabilities: session } } };
}

function parse(line: string): Json | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Reads "1.5.14" (or the first x.y.z) from `agy --version` output. */
export function parseAgyVersion(text: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function isAgyVersionTooOld(version: readonly number[]): boolean {
  for (let i = 0; i < MIN_AGY_ACP_VERSION.length; i++) {
    if (version[i] !== MIN_AGY_ACP_VERSION[i]) return version[i] < MIN_AGY_ACP_VERSION[i];
  }
  return false;
}

/** When agy fails before answering, explains an outdated CLI; undefined when the version is fine or unknown. */
export function describeOutdatedAgy(command: string, readVersion: () => string): string | undefined {
  let version: [number, number, number] | undefined;
  try {
    version = parseAgyVersion(readVersion());
  } catch {
    return undefined;
  }
  if (!version || !isAgyVersionTooOld(version)) return undefined;
  return `Antigravity CLI ${version.join(".")} (${command}) is too old for bb: \`agy acp\` needs ${MIN_AGY_ACP_VERSION.join(".")} or later. Run \`agy update\` on this machine, then retry.`;
}

/** Loads node:sqlite when this Node has it; forking is off otherwise. */
async function loadSqlite(): Promise<SqliteDatabaseClass | undefined> {
  try {
    const sqlite: any = await import("node:sqlite");
    return sqlite.DatabaseSync as SqliteDatabaseClass;
  } catch {
    return undefined;
  }
}

/** Runs the proxy as this process: argv is the agy command and its arguments. */
export async function runAgyAcpProxy(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const log = (message: string) => process.stderr.write(`agy-acp-proxy: ${message}\n`);
  if (!command) {
    log("missing agy command");
    process.exit(64);
  }
  const disabled = process.env[AGY_ACP_PROXY_SWITCH_ENV] === "0";
  const Database = disabled ? undefined : await loadSqlite();
  if (!Database && !disabled) log("node:sqlite is unavailable in this Node.js; session/fork is not offered");
  const appDataDir = resolveAgyAppDataDir(args);
  const stateDir = process.env[AGY_ACP_PROXY_STATE_DIR_ENV] || undefined;
  if (stateDir && !disabled) setImmediate(() => pruneInstructionStore(stateDir, appDataDir));
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv, shell: false });
  // Hold agy's stderr until it answers (or briefly), so an outdated-CLI explanation can lead the error bb shows.
  let answered = false;
  let held: Buffer[] | undefined = [];
  const releaseStderr = () => {
    if (!held) return;
    for (const chunk of held) process.stderr.write(chunk);
    held = undefined;
  };
  const holdTimer = setTimeout(releaseStderr, STDERR_HOLD_MS);
  holdTimer.unref();
  child.stderr.on("data", (chunk: Buffer) => (held ? held.push(chunk) : process.stderr.write(chunk)));
  const toAgent = (line: string) => { child.stdin.write(`${line}\n`); };
  const toClient = (line: string) => { process.stdout.write(`${line}\n`); };
  const proxy = disabled ? { fromClient: toAgent, fromAgent: toClient } : new AgyAcpProxy({
    toAgent,
    toClient,
    store: createInstructionStore(stateDir, appDataDir, log),
    ...(Database ? { fork: (sourceId: string) => forkAgyConversation(appDataDir, sourceId, Database, undefined, log) } : {}),
    log,
  });
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => proxy.fromClient(line));
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => {
    if (!answered) {
      answered = true;
      releaseStderr();
    }
    proxy.fromAgent(line);
  });
  process.stdin.on("end", () => child.stdin.end());
  child.stdin.on("error", () => {});
  child.on("error", error => {
    log(`could not start ${command}: ${error.message}`);
    process.exit(127);
  });
  child.on("close", (code, signal) => {
    if (!answered && code !== 0 && held) {
      const outdated = describeOutdatedAgy(command, () => execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10_000, env: childEnv }));
      if (outdated) process.stderr.write(`${outdated}\n`);
    }
    releaseStderr();
    process.exit(code ?? (signal ? 1 : 0));
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => child.kill(signal));
  }
}
