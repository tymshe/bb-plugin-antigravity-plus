import { experimental_acpLaunchSpecSchema, experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { threadStartParamsSchema, threadResumeParamsSchema, turnStartParamsSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { createAutoCompactionTracker } from "./auto-compaction.ts";
import { createBackgroundTaskTracker, defaultBackgroundTaskStatePath } from "./background-tasks.ts";
import { ANTIGRAVITY_ACP_DIALECT_ID, applyThreadCommandDescriptionMessage, onToolUpdate, registerAntigravityAcpDialect } from "./dialect.ts";
import { jsonlOutput, presentModeControlMessage } from "./mode-controls.ts";
import { mapPromptMode, NATIVE_AUTO_MODE } from "./prompt-mode.ts";
import { createProfileBindings } from "./profile-bindings.ts";
import { interceptSubagentApprovalMessage, isSubagentApprovalForDisabledThread, transformSubagentRequest } from "./subagents.ts";
import { readSwarmBoard } from "./swarm-board.ts";
import { swarmHostContract } from "./swarm-contract.ts";
import { readAntigravityProviderUsage } from "./usage.ts";
import { planAntigravityInstallationRun, readAntigravityHealth, readAntigravityInstallationStatus } from "./maintenance.ts";
import { resolveAntigravityCommand, resolveAntigravityLaunchSpec } from "./cli.ts";
import { AGY_ACP_PROXY_FLAG, runAgyAcpProxy } from "./acp-proxy.ts";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const isAcpProxyProcess = process.argv[2] === AGY_ACP_PROXY_FLAG;
const MAX_TRACKED_SANDBOX_ESCAPES = 500;

let rawStdoutWrite: typeof process.stdout.write | null = null;
let trackerInstance: ReturnType<typeof createBackgroundTaskTracker> | null = null;
let autoCompactionInstance: ReturnType<typeof createAutoCompactionTracker> | null = null;
let profileBindings: ReturnType<typeof createProfileBindings> | undefined;

function getProfileBindings() {
  return profileBindings ??= createProfileBindings();
}

function getAutoCompactionTracker() {
  if (!autoCompactionInstance) {
    autoCompactionInstance = createAutoCompactionTracker();
  }
  return autoCompactionInstance;
}

function getBackgroundTaskTracker() {
  if (!trackerInstance) {
    trackerInstance = createBackgroundTaskTracker({
      persistPath: defaultBackgroundTaskStatePath(),
      onAsyncDeltas(threadId, deltas) {
        if (!deltas.length) return;
        const write = rawStdoutWrite ?? process.stdout.write.bind(process.stdout);
        write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/delta", params: { threadId, deltas } })}\n`);
      },
    });
  }
  return trackerInstance;
}

const unscopedSandboxEscapeIds = new Set<string>();
const sandboxEscapeByThread = new Map<string, Set<string>>();
const threadCwds = new Map<string, string>();
const openAssistantStreams = new Set<string>();

function rememberUnscopedSandboxEscape(toolCallId: string): void {
  if (unscopedSandboxEscapeIds.size >= MAX_TRACKED_SANDBOX_ESCAPES) {
    const oldest = unscopedSandboxEscapeIds.values().next().value;
    if (oldest) unscopedSandboxEscapeIds.delete(oldest);
  }
  unscopedSandboxEscapeIds.add(toolCallId);
}

function rememberThreadSandboxEscape(threadId: string, itemId: string): void {
  let set = sandboxEscapeByThread.get(threadId);
  if (!set) {
    set = new Set<string>();
    sandboxEscapeByThread.set(threadId, set);
  }
  if (set.size >= MAX_TRACKED_SANDBOX_ESCAPES) {
    const oldest = set.values().next().value;
    if (oldest) set.delete(oldest);
  }
  set.add(itemId);
}

export function recordSandboxEscapeToolCall(toolCallId: string, threadId?: string): void {
  if (!toolCallId) return;
  if (threadId) rememberThreadSandboxEscape(threadId, toolCallId);
  else rememberUnscopedSandboxEscape(toolCallId);
}

function recordSandboxEscapeDeltas(message: any): void {
  const params = message?.params;
  if (message?.method !== "thread/delta" || typeof params?.threadId !== "string" || !Array.isArray(params.deltas)) {
    return;
  }
  for (const delta of params.deltas) {
    const presentation = delta?.presentation;
    if (!presentation || typeof presentation !== "object") continue;
    const hasBadge =
      (typeof presentation.badge?.label === "string" && /outside\s+(?:of\s+)?sandbox/i.test(presentation.badge.label)) ||
      (Array.isArray(presentation.badges) &&
        presentation.badges.some((b: any) => typeof b?.label === "string" && /outside\s+(?:of\s+)?sandbox/i.test(b.label)));
    if (!hasBadge) continue;
    const itemId =
      typeof delta.providerItemId === "string" && delta.providerItemId.length > 0
        ? delta.providerItemId
        : typeof delta.item?.id === "string" && delta.item.id.length > 0
          ? delta.item.id
          : null;
    if (itemId) rememberThreadSandboxEscape(params.threadId, itemId);
  }
}

if (!isAcpProxyProcess) {
  registerAntigravityAcpDialect();
  onToolUpdate(event => {
    const rawInput = event?.rawInput && typeof event.rawInput === "object" ? (event.rawInput as Record<string, unknown>) : null;
    if (rawInput?.BypassSandbox === true && typeof event.toolCallId === "string" && event.toolCallId.length > 0) {
      rememberUnscopedSandboxEscape(event.toolCallId);
    }
    getBackgroundTaskTracker().recordToolEvent({ ...event, rawInput: rawInput ?? undefined });
  });
}

function sanitizeProbeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "ELECTRON_RUN_AS_NODE" || typeof value !== "string") continue;
    result[key] = value;
  }
  return result;
}

function parseMaintenanceRequest(parsed: unknown): {
  id: string | number;
  method: "provider/usage" | "provider/health" | "provider/installation/status" | "provider/installation/run";
  action?: "install" | "update";
  checkUpdates?: boolean;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
} | null {
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const method = record.method;
  if (
    method !== "provider/usage" &&
    method !== "provider/health" &&
    method !== "provider/installation/status" &&
    method !== "provider/installation/run"
  ) {
    return null;
  }
  const id = record.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const params = record.params && typeof record.params === "object" ? (record.params as Record<string, unknown>) : undefined;
  const providerOptions =
    params?.providerOptions && typeof params.providerOptions === "object"
      ? (params.providerOptions as Record<string, unknown>)
      : undefined;
  const spec = experimental_acpLaunchSpecSchema.safeParse(providerOptions?.acpLaunchSpec);
  const action = params?.action === "install" || params?.action === "update" ? params.action : undefined;
  const checkUpdates = typeof params?.checkUpdates === "boolean" ? params.checkUpdates : undefined;
  const envVars =
    params?.envVars && typeof params.envVars === "object" && !Array.isArray(params.envVars)
      ? (params.envVars as Record<string, string>)
      : undefined;
  return {
    id,
    method,
    action,
    checkUpdates,
    command: spec.success ? spec.data.command : "agy",
    cwd: spec.success ? spec.data.cwd : (typeof params?.cwd === "string" ? params.cwd : undefined),
    env: { ...(spec.success ? spec.data.env : undefined), ...envVars },
  };
}

let stdoutFilterInstalled = false;
const hostFile = fileURLToPath(import.meta.url);
let proxyStateDir: string | undefined;
const autoApproveThreads = new Map<string, boolean>();
const promptOnSandboxEscapeThreads = new Map<string, boolean>();
const commandDescriptionsThreads = new Map<string, boolean>();
const nativeAutoOffered = new Map<string, boolean>();
const nativeAutoWarned = new Set<string>();

// Must run before presentModeControlMessage, which narrows the native modes to Build and Plan.
export function recordNativeModes(message: any): void {
  const threadId = message?.params?.threadId;
  if (message?.method !== "thread/delta" || typeof threadId !== "string" || !Array.isArray(message.params.deltas)) return;
  for (const delta of message.params.deltas) {
    if (delta?.kind !== "extension.state" || delta.extensionKind !== "bb/session-options" || !Array.isArray(delta.payload?.options)) continue;
    const mode = delta.payload.options.find((option: any) => option?.id === "mode" && Array.isArray(option.values));
    if (mode) nativeAutoOffered.set(threadId, mode.values.some((value: any) => value?.id === NATIVE_AUTO_MODE));
  }
}

function nativeAutoAvailable(threadId: string): boolean | undefined {
  return nativeAutoOffered.get(threadId);
}

// Tell the user once per thread when BB Auto has to fall back to Accept edits.
function warnIfNativeAutoUnavailable(request: any): void {
  const threadId = request?.params?.threadId;
  const method = request?.method;
  if ((method !== "turn/start" && method !== "turn/steer") || typeof threadId !== "string" ||
      request.params.options?.permissionMode !== "auto" || nativeAutoOffered.get(threadId) !== false ||
      nativeAutoWarned.has(threadId)) return;
  nativeAutoWarned.add(threadId);
  const write = rawStdoutWrite ?? process.stdout.write.bind(process.stdout);
  write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/delta", params: { threadId, deltas: [{
    kind: "provider.warning",
    summary: "Antigravity Auto is not available, using Accept edits",
    details: "This agy session does not offer its native Auto mode, so requests are sent to you for approval. Auto needs agy 1.5.4+, an account where Google has rolled it out, and the OS terminal sandbox (try the plugin's sandbox setting).",
  }] } })}\n`);
}

export function rememberApprovalSetting(request: any) {
  if (request?.method === "thread/stop" || request?.method === "thread/discard") {
    const threadId = request?.params?.threadId;
    if (typeof threadId === "string") {
      autoApproveThreads.delete(threadId);
      promptOnSandboxEscapeThreads.delete(threadId);
      commandDescriptionsThreads.delete(threadId);
      sandboxEscapeByThread.delete(threadId);
      threadCwds.delete(threadId);
      openAssistantStreams.delete(threadId);
      nativeAutoOffered.delete(threadId);
      nativeAutoWarned.delete(threadId);
    }
    return;
  }
  const method = request?.method;
  const params = request?.params;
  if (!params || typeof params !== "object" || typeof params.threadId !== "string") return;

  if (typeof params.cwd === "string" && params.cwd.trim().length > 0) {
    threadCwds.set(params.threadId, resolve(params.cwd));
  }

  const schema = method === "thread/start" ? threadStartParamsSchema
    : method === "thread/resume" ? threadResumeParamsSchema
    : method === "turn/start" ? turnStartParamsSchema : null;
  const parsed = schema?.safeParse(params);
  const options = parsed?.success
    ? parsed.data.options
    : (schema || method === "turn/steer" || method === "thread/fork") &&
      params.options && typeof params.options === "object" && !Array.isArray(params.options)
      ? params.options
      : null;

  if (options && typeof options === "object") {
    const providerOptions = options.providerOptions;
    if (typeof providerOptions?.commandDescriptionsEnabled === "boolean") {
      commandDescriptionsThreads.set(params.threadId, providerOptions.commandDescriptionsEnabled);
    }
    if (providerOptions && typeof providerOptions === "object") {
      promptOnSandboxEscapeThreads.set(params.threadId, providerOptions.promptOnSandboxEscape !== false);
    }
    if (typeof options.permissionMode === "string" && typeof options.permissionEscalation === "string") {
      autoApproveThreads.set(
        params.threadId,
        providerOptions?.autoApprove === true &&
          options.permissionMode === "accept-edits" &&
          options.permissionEscalation === "ask",
      );
    }
  }
}

function applyAntigravityDefaults(line: string, parsed: unknown): { line: string; parsed: unknown } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { line, parsed };
  const record = parsed as Record<string, any>;
  const params = record.params && typeof record.params === "object" && !Array.isArray(record.params)
    ? (record.params as Record<string, any>)
    : null;
  if (!params) return { line, parsed };
  const options = params.options && typeof params.options === "object" && !Array.isArray(params.options)
    ? (params.options as Record<string, any>)
    : null;
  const providerOptions = options?.providerOptions && typeof options.providerOptions === "object" && !Array.isArray(options.providerOptions)
    ? (options.providerOptions as Record<string, any>)
    : null;
  if (typeof params.threadId === "string" && typeof providerOptions?.commandDescriptionsEnabled === "boolean") {
    commandDescriptionsThreads.set(params.threadId, providerOptions.commandDescriptionsEnabled);
  }
  if (providerOptions && (!providerOptions.acpDialect || providerOptions.acpDialect === "acp")) {
    const updated = {
      ...record,
      params: {
        ...params,
        options: {
          ...options,
          providerOptions: {
            ...providerOptions,
            acpDialect: ANTIGRAVITY_ACP_DIALECT_ID,
          },
        },
      },
    };
    return { line: JSON.stringify(updated), parsed: updated };
  }
  return { line, parsed };
}

function isPathOutsideWorkspace(writeScope: string, workspaceCwd: string): boolean {
  const rel = relative(resolve(workspaceCwd), resolve(workspaceCwd, writeScope));
  return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);
}

function isSandboxEscapeApproval(payload: any, threadId?: string): boolean {
  const itemId = typeof payload?.subject?.itemId === "string" ? payload.subject.itemId : null;
  if (itemId) {
    if (unscopedSandboxEscapeIds.has(itemId)) return true;
    if (threadId && sandboxEscapeByThread.get(threadId)?.has(itemId)) return true;
  }
  const reason = typeof payload?.reason === "string" ? payload.reason : "";
  if (/\b(?:outside\s+(?:of\s+)?sandbox|bypass\s*sandbox|sandbox\s+escape)\b/i.test(reason)) return true;
  const badges = payload?.subject?.presentation?.badges;
  if (Array.isArray(badges) && badges.some((b: any) => typeof b?.label === "string" && /outside\s+(?:of\s+)?sandbox/i.test(b.label))) return true;
  if (payload?.subject?.rawInput?.BypassSandbox === true) return true;
  if (
    payload?.subject?.kind === "file_change" &&
    typeof payload.subject.writeScope === "string" &&
    threadId &&
    threadCwds.has(threadId) &&
    isPathOutsideWorkspace(payload.subject.writeScope, threadCwds.get(threadId)!)
  ) {
    return true;
  }
  return false;
}

export function interceptApproval(line: string): boolean {
  let message: any;
  try { message = JSON.parse(line); } catch { return false; }
  return interceptApprovalMessage(message);
}

function interceptApprovalMessage(message: any): boolean {
  if (message?.method !== "interaction/request") return false;
  if (interceptSubagentApprovalMessage(message)) return true;
  if (isSubagentApprovalForDisabledThread(message)) return false;
  const threadId = message?.params?.threadId;
  if (message?.jsonrpc !== "2.0" || message.method !== "interaction/request" ||
      (typeof message.id !== "string" && typeof message.id !== "number") ||
      !autoApproveThreads.get(threadId)) return false;
  const payload = message.params?.payload;
  if (promptOnSandboxEscapeThreads.get(threadId) !== false && isSandboxEscapeApproval(payload, threadId)) return false;
  if (payload?.kind !== "approval" || typeof payload.subject?.itemId !== "string" ||
      !["command", "file_change", "tool_use"].includes(payload.subject.kind) ||
      !(payload.reason === null || typeof payload.reason === "string") ||
      !Array.isArray(payload.availableDecisions) ||
      !payload.availableDecisions.every((value: unknown) => ["allow_once", "allow_for_session", "deny"].includes(value as string))) return false;
  const subject = payload.subject;
  if (subject.kind === "command" && (typeof subject.command !== "string" || !Array.isArray(subject.actions) || !(subject.cwd === null || typeof subject.cwd === "string") || subject.sessionGrant !== null)) return false;
  if (subject.kind === "file_change" && (!(subject.writeScope === null || typeof subject.writeScope === "string") || subject.sessionGrant !== null)) return false;
  if (subject.kind === "tool_use" && (typeof subject.tool !== "string" || typeof subject.presentation?.icon?.glyph !== "string" || typeof subject.presentation?.label?.pending !== "string" || typeof subject.presentation?.label?.completed !== "string")) return false;
  const decisions = payload.availableDecisions;
  const decision = decisions.includes("allow_once") ? "allow_once" : decisions.includes("allow_for_session") ? "allow_for_session" : null;
  if (!decision) return false;
  queueMicrotask(() => experimental_acpProviderBridge.handleLine(JSON.stringify({
    jsonrpc: "2.0", id: message.id, result: { decision, grantedPermissions: null },
  })));
  return true;
}

const assistantTextClose = {
  kind: "item.textClose",
  key: { channel: "assistant" },
  channel: "agentMessage",
} as const;

// SDK 0.6.157 does not close the assistant stream when thought starts.
export function closeAssistantBeforeReasoning<Delta extends { kind?: string; channel?: string }>(
  threadId: string,
  deltas: readonly Delta[],
  openStreams: Set<string>,
): readonly (Delta | typeof assistantTextClose)[] {
  let ordered: (Delta | typeof assistantTextClose)[] | undefined;
  for (const [index, delta] of deltas.entries()) {
    if (delta?.kind === "turn.boundary" || delta?.kind === "session.reset") {
      openStreams.delete(threadId);
    } else if (delta?.channel === "agentMessage") {
      if (delta.kind === "item.textDelta") openStreams.add(threadId);
      if (delta.kind === "item.textClose") openStreams.delete(threadId);
    } else if (
      delta?.kind === "item.textDelta" &&
      (delta.channel === "reasoningText" || delta.channel === "reasoningSummary") &&
      openStreams.delete(threadId)
    ) {
      ordered ??= deltas.slice(0, index);
      ordered.push(assistantTextClose);
    }
    ordered?.push(delta);
  }
  return ordered ?? deltas;
}

function processBridgeOutputLine(line: string): string[] {
  let message;
  try { message = JSON.parse(line); } catch { return [line]; }

  if (interceptApprovalMessage(message)) return [];
  recordNativeModes(message);
  const modesChanged = presentModeControlMessage(message);
  const profileChanged = getProfileBindings().processStdoutMessage(message);
  const descriptionsChanged = applyThreadCommandDescriptionMessage(message, commandDescriptionsThreads);
  recordSandboxEscapeDeltas(message);
  const compactionChanged = getAutoCompactionTracker().processStdoutMessage(message);
  let tasksChanged = false;
  let streamChanged = false;
  const params = message?.params;
  if (message?.method === "thread/delta" && typeof params?.threadId === "string" && Array.isArray(params.deltas)) {
    tasksChanged = getBackgroundTaskTracker().processStdoutMessage(message);
    const ordered = closeAssistantBeforeReasoning(params.threadId, params.deltas, openAssistantStreams);
    streamChanged = ordered !== params.deltas;
    if (streamChanged) params.deltas = ordered;
  }
  return [profileChanged || modesChanged || descriptionsChanged || compactionChanged || tasksChanged || streamChanged
    ? JSON.stringify(message)
    : line];
}

function ensureStdoutFilter() {
  if (stdoutFilterInstalled) return;
  stdoutFilterInstalled = true;
  registerAntigravityAcpDialect();
  const write = process.stdout.write.bind(process.stdout);
  rawStdoutWrite = write;
  const output = jsonlOutput(processBridgeOutputLine);
  output.on("data", chunk => write(chunk));
  process.stdout.write = ((chunk: any, encodingOrCallback?: any, callback?: any) =>
    output.write(chunk, encodingOrCallback, callback)) as typeof process.stdout.write;
}

function disposeTracker() {
  trackerInstance?.dispose();
  autoCompactionInstance?.dispose();
  profileBindings = undefined;
  openAssistantStreams.clear();
}

export const experimental_providerBridge = {
  ...experimental_acpProviderBridge,
  start(context?: { dataDir?: string }) {
    if (typeof context?.dataDir === "string") proxyStateDir = join(context.dataDir, "acp-proxy", "instructions");
    ensureStdoutFilter();
  },
  onClose() {
    disposeTracker();
    (experimental_acpProviderBridge as any).onClose?.();
  },
  onSigterm() {
    disposeTracker();
    (experimental_acpProviderBridge as any).onSigterm?.();
  },
  onSigint() {
    disposeTracker();
    (experimental_acpProviderBridge as any).onSigint?.();
  },
  handleLine(line: string) {
    ensureStdoutFilter();
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { parsed = null; }
    const profileError = getProfileBindings().handleRequest(parsed);
    if (profileError) {
      const write = rawStdoutWrite ?? process.stdout.write.bind(process.stdout);
      const { id, message } = profileError;
      write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
      return;
    }
    resolveAntigravityLaunchSpec(parsed, { hostFile, stateDir: proxyStateDir });
    if (parsed !== null) line = JSON.stringify(parsed);
    const withDefaults = applyAntigravityDefaults(line, parsed);
    const subagentTransformed = transformSubagentRequest(withDefaults.line, withDefaults.parsed);
    rememberApprovalSetting(subagentTransformed.parsed);
    const maintenanceRequest = parseMaintenanceRequest(subagentTransformed.parsed);
    if (maintenanceRequest !== null) {
      const write = rawStdoutWrite ?? process.stdout.write.bind(process.stdout);
      const probeOptions = {
        command: maintenanceRequest.command,
        cwd: maintenanceRequest.cwd,
        env: sanitizeProbeEnv({ ...process.env, ...maintenanceRequest.env }),
        resolveCommand: (command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv }) =>
          resolveAntigravityCommand(command, command === "agy" ? { env: process.env } : options),
      };
      if (maintenanceRequest.method === "provider/usage") {
        void readAntigravityProviderUsage(probeOptions).then(result => {
          write(`${JSON.stringify({ jsonrpc: "2.0", id: maintenanceRequest.id, result })}\n`);
        }).catch(error => {
          const result = {
            supported: true,
            usage: {
              status: "error",
              message: error instanceof Error ? error.message : "Antigravity CLI usage could not be collected.",
              planLabel: null,
              accountEmail: null,
            },
          };
          write(`${JSON.stringify({ jsonrpc: "2.0", id: maintenanceRequest.id, result })}\n`);
        });
        return;
      }
      if (maintenanceRequest.method === "provider/health") {
        void readAntigravityHealth(probeOptions).then(result => {
          write(`${JSON.stringify({ jsonrpc: "2.0", id: maintenanceRequest.id, result })}\n`);
        }).catch(error => {
          write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: maintenanceRequest.id,
            result: {
              supported: true,
              health: {
                status: "unknown",
                statusMessage: error instanceof Error ? error.message : "Antigravity CLI health check failed.",
                accountEmail: null,
                planLabel: null,
                installedVersion: null,
                minimumSupportedVersion: "1.5.0",
                canInstall: false,
                canUpdate: false,
                loginCommand: "agy acp --login",
              },
            },
          })}\n`);
        });
        return;
      }
      if (maintenanceRequest.method === "provider/installation/status") {
        void readAntigravityInstallationStatus({
          ...probeOptions,
          checkUpdates: maintenanceRequest.checkUpdates ?? true,
        }).then(result => {
          write(`${JSON.stringify({ jsonrpc: "2.0", id: maintenanceRequest.id, result })}\n`);
        }).catch(error => {
          write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: maintenanceRequest.id,
            error: { code: -32000, message: error instanceof Error ? error.message : "Failed to inspect Antigravity CLI installation." },
          })}\n`);
        });
        return;
      }
      if (maintenanceRequest.method === "provider/installation/run") {
        const action = maintenanceRequest.action ?? "update";
        void planAntigravityInstallationRun(action, probeOptions).then(result => {
          write(`${JSON.stringify({ jsonrpc: "2.0", id: maintenanceRequest.id, result })}\n`);
        }).catch(error => {
          write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: maintenanceRequest.id,
            result: { available: false, message: error instanceof Error ? error.message : "Failed to plan Antigravity CLI maintenance." },
          })}\n`);
        });
        return;
      }
    }
    getAutoCompactionTracker().handleInboundRequest(subagentTransformed.parsed);
    const closeDeltas = getBackgroundTaskTracker().handleInboundRequest(subagentTransformed.parsed);
    if (closeDeltas.length > 0) {
      const stopThreadId = (subagentTransformed.parsed as Record<string, any> | null)?.params?.threadId;
      if (typeof stopThreadId === "string") {
        const write = rawStdoutWrite ?? process.stdout.write.bind(process.stdout);
        write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/delta", params: { threadId: stopThreadId, deltas: closeDeltas } })}\n`);
      }
    }
    warnIfNativeAutoUnavailable(subagentTransformed.parsed);
    experimental_acpProviderBridge.handleLine(mapPromptMode(subagentTransformed.line, subagentTransformed.parsed, nativeAutoAvailable));
  },
};

export default experimental_defineHostEntry({
  contract: swarmHostContract,
  handlers: {
    readSwarmBoard: ({ providerThreadId }) => readSwarmBoard(providerThreadId),
  },
});

// bb imports this module as the provider bridge and host RPC entry; agy sessions start it again as the ACP proxy.
if (isAcpProxyProcess) void runAgyAcpProxy(process.argv.slice(3));
