import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { resolveAntigravityLaunchProfile } from "./cli.ts";

const MISMATCH = "The Antigravity profile changed for this session. Restore its original Gemini and app data directories before retrying.";
const STATE_ERROR = "Could not read or save the Antigravity profile binding. Check the plugin state directory and retry.";
const SESSION_PENDING = "An Antigravity session is still opening for this thread. Retry when it is ready.";
const LOCK_STALE_MS = 5_000;
const LOCK_WAIT_MS = 150;
const lockWait = new Int32Array(new SharedArrayBuffer(4));

const bindingSchema = z.object({
  threadId: z.string().min(1),
  profileHash: z.string().regex(/^[0-9a-f]{64}$/),
  appDataDir: z.string().min(1).optional(),
  sessionIds: z.array(z.string().min(1)),
});
const stateSchema = z.object({ version: z.literal(1), bindings: z.array(bindingSchema) });
type Binding = z.infer<typeof bindingSchema>;
type RequestId = string | number;
type ProfileBindingError = { id: RequestId; message: string };

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.enum(["thread/start", "thread/resume", "thread/fork", "turn/start", "thread/stop", "thread/discard"]),
  params: z.object({
    threadId: z.string().min(1),
    providerThreadId: z.string().min(1).optional(),
    sourceProviderThreadId: z.string().min(1).optional(),
  }),
});

export function defaultProfileBindingsPath(): string {
  const dir = process.env.BB_ANTIGRAVITY_TASK_STATE_DIR?.trim() ||
    join(homedir(), ".bb", "plugin-data", "bb-plugin-antigravity-plus");
  return join(dir, "profile-bindings.json");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function readBindings(path: string): Binding[] {
  try {
    return stateSchema.parse(JSON.parse(readFileSync(path, "utf8"))).bindings;
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function acquireLock(path: string): number {
  const deadline = performance.now() + LOCK_WAIT_MS;
  while (performance.now() < deadline) {
    try {
      return openSync(path, "wx", 0o600);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    Atomics.wait(lockWait, 0, 0, 5);
  }
  throw new Error("Antigravity profile bindings are locked");
}

function updateBindings(path: string, update: (bindings: Binding[]) => boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const fd = acquireLock(lockPath);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const bindings = readBindings(path);
    if (!update(bindings)) return;
    writeFileSync(temp, `${JSON.stringify({ version: 1, bindings })}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch { /* The rename may already have moved it. */ }
    closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* A stale lock cleanup may already have removed it. */ }
  }
}

function matchesProfile(bindings: Binding[], threadId: string, sessionId: string | undefined, hash: string): boolean {
  return bindings.every(binding => binding.profileHash === hash ||
    (binding.threadId !== threadId && (sessionId === undefined || !binding.sessionIds.includes(sessionId))));
}

/** Checks the profile before forwarding, and records the raw session identity when agy opens it. */
export function createProfileBindings(path = defaultProfileBindingsPath()) {
  const pending = new Map<RequestId, { threadId: string; sessionId?: string; hash: string; appDataDir: string }>();

  function handleRequest(request: unknown): ProfileBindingError | undefined {
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) return;
    const { id, method, params: { threadId, providerThreadId, sourceProviderThreadId } } = parsed.data;
    if (method === "thread/stop" || method === "thread/discard") {
      for (const [reqId, opening] of pending) {
        if (opening.threadId === threadId) pending.delete(reqId);
      }
      if (method === "thread/stop") return;
      try {
        const bindings = readBindings(path);
        if (providerThreadId && bindings.some(binding => binding.threadId === threadId)) {
          updateBindings(path, records => {
            const index = records.findIndex(binding => binding.threadId === threadId);
            if (index < 0) return false;
            records.splice(index, 1);
            return true;
          });
        }
      } catch {
        // Tolerate an unreadable state file on discard so cleanup cannot be blocked.
      }
      return;
    }
    if ([...pending.values()].some(opening => opening.threadId === threadId)) {
      return { id, message: SESSION_PENDING };
    }

    try {
      const bindings = readBindings(path);
      const { geminiDir, appDataDir } = resolveAntigravityLaunchProfile(request);
      const hash = createHash("sha256").update(JSON.stringify([resolve(geminiDir), resolve(appDataDir)])).digest("hex");
      const sessionId = method === "thread/fork" ? sourceProviderThreadId : providerThreadId;
      if (!matchesProfile(bindings, threadId, sessionId, hash)) return { id, message: MISMATCH };
      if (method !== "turn/start") {
        pending.set(id, { threadId, sessionId, hash, appDataDir: resolve(appDataDir) });
      }
    } catch {
      return { id, message: STATE_ERROR };
    }
  }

  function processStdoutMessage(message: any): boolean {
    const opening = message?.method === undefined ? pending.get(message?.id) : undefined;
    if (opening) {
      pending.delete(message.id);
      const sessionId = message.result?.providerThreadId;
      if (typeof sessionId !== "string" || !sessionId) return false;
      const { threadId, hash, appDataDir } = opening;
      let error: string | undefined;
      try {
        updateBindings(path, bindings => {
          if (!matchesProfile(bindings, threadId, opening.sessionId, hash)) {
            error = MISMATCH;
            return false;
          }
          const previous = bindings.find(binding => binding.threadId === threadId);
          if (!previous) {
            bindings.push({ threadId, profileHash: hash, appDataDir, sessionIds: [sessionId] });
            return true;
          }
          const hasSession = previous.sessionIds.includes(sessionId);
          if (hasSession && previous.appDataDir === appDataDir) return false;
          if (!hasSession) previous.sessionIds.push(sessionId);
          previous.appDataDir = appDataDir;
          return true;
        });
      } catch {
        error = STATE_ERROR;
      }
      if (!error) return false;
      delete message.result;
      message.error = { code: -32000, message: error };
      return true;
    }

    if (message?.method !== "session/replaced") return false;
    const { threadId, providerThreadId } = message.params ?? {};
    if (typeof threadId !== "string" || typeof providerThreadId !== "string") return false;
    try {
      const previous = readBindings(path).find(binding => binding.threadId === threadId);
      if (previous && !previous.sessionIds.includes(providerThreadId)) {
        updateBindings(path, bindings => {
          const current = bindings.find(binding => binding.threadId === threadId && binding.profileHash === previous.profileHash);
          if (!current || current.sessionIds.includes(providerThreadId)) return false;
          current.sessionIds.push(providerThreadId);
          return true;
        });
      }
    } catch {
      // Surface the persistence failure alongside the replacement identity.
      message.params = { ...message.params, reason: `${message.params.reason} ${STATE_ERROR}`, showRuntimeNote: true };
      return true;
    }
    return false;
  }

  function getAppDataDir(providerThreadId: string): string | undefined {
    try {
      return readBindings(path).find(binding => binding.appDataDir && binding.sessionIds.includes(providerThreadId))?.appDataDir;
    } catch {
      return undefined;
    }
  }

  return { handleRequest, processStdoutMessage, getAppDataDir };
}
