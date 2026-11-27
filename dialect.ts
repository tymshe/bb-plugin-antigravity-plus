import {
  experimental_registerAcpDialect,
  type AcpDialect,
  type AcpToolCallUpdateEvent,
  type AcpToolIdentity,
  type AcpToolKind,
} from "@get-bb/plugin-sdk/provider-bridge/acp";

export type AcpToolUpdateEvent = AcpToolCallUpdateEvent;

export interface AcpDialectToolIdentity {
  name?: string;
  kind?: AcpToolKind;
}

export interface DialectPresentationBadge {
  label: string;
  tone: "destructive" | "neutral";
  glyph?: string;
  hint?: string;
}

export interface DialectPresentation {
  label: {
    pending: string;
    completed: string;
  };
  icon: {
    glyph: string;
  };
  title?: string;
  subtitle?: string;
  detail?: string;
  badge?: {
    glyph: string;
    label: string;
    hint: string;
    tone: "destructive" | "neutral";
  };
  badges?: DialectPresentationBadge[];
}

const PRESENTATION_DETAIL_MAX_LENGTH = 280;

function truncatePresentationDetail(text: string): string {
  return text.length > PRESENTATION_DETAIL_MAX_LENGTH
    ? `${text.slice(0, PRESENTATION_DETAIL_MAX_LENGTH - 3)}...`
    : text;
}

export type AcpDialectToolClassification =
  | {
      kind: "command";
      presentation: DialectPresentation;
      item?: Record<string, unknown>;
    }
  | {
      kind: "delegation";
      label: string;
      detail?: string | null;
      background: boolean;
      childRef?: string;
      presentation: DialectPresentation;
      item?: Record<string, unknown>;
    }
  | {
      kind: "tool_use";
      tool: string;
      detail?: string | null;
      presentation: DialectPresentation;
      item?: Record<string, unknown>;
    };

export const ANTIGRAVITY_ACP_DIALECT_ID = "antigravity-plus";

export const CANONICAL_ANTIGRAVITY_TOOLS: ReadonlySet<string> = new Set([
  // Execution
  "run_command",
  // File reading
  "read_file",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "list_dir",
  "list_resources",
  "read_resource",
  // File editing
  "write_file",
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
  // Search
  "grep_search",
  "code_search",
  "find_by_name",
  // Web / Fetch
  "search_web",
  "read_url_content",
  // Subagents
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "send_message",
  // Swarm
  "swarm",
  "post_message",
  "read_board",
  "swarm_wait",
  // Background tasks & scheduling
  "manage_task",
  "schedule",
  // User interaction
  "ask_question",
]);

export function applyThreadCommandDescriptionMessage(
  message: any,
  enabledByThread: ReadonlyMap<string, boolean>,
): boolean {
  const params = message?.params;
  if (
    message?.method !== "thread/delta" ||
    typeof params?.threadId !== "string" ||
    !Array.isArray(params.deltas)
  ) {
    return false;
  }

  const enabled = enabledByThread.get(params.threadId) ?? true;
  let modified = false;

  for (const delta of params.deltas) {
    if (delta?.item?.type === "command" && delta?.presentation && typeof delta.presentation === "object") {
      if (
        !enabled &&
        typeof delta.item.command === "string" &&
        delta.item.command.length > 0 &&
        (delta.presentation.subtitle === delta.item.command ||
          delta.presentation.detail === truncatePresentationDetail(delta.item.command))
      ) {
        delta.presentation.title = delta.item.command;
        delete delta.presentation.subtitle;
        delete delta.presentation.detail;
        modified = true;
      }
    }
  }

  return modified;
}

export function extractEventOutputText(event: { content?: unknown; rawOutput?: unknown }): string {
  const parts: string[] = [];
  function collect(val: unknown) {
    if (typeof val === "string") {
      parts.push(val);
    } else if (Array.isArray(val)) {
      for (const item of val) collect(item);
    } else if (val && typeof val === "object") {
      const obj = val as Record<string, unknown>;
      if (typeof obj.text === "string") parts.push(obj.text);
      if (typeof obj.output === "string") parts.push(obj.output);
      if (typeof obj.content === "string") parts.push(obj.content);
      if (typeof obj.stdout === "string") parts.push(obj.stdout);
      if (typeof obj.stderr === "string") parts.push(obj.stderr);
      if (obj.content && typeof obj.content === "object" && obj.content !== null) {
        collect(obj.content);
      }
    }
  }
  if (event.content !== undefined) collect(event.content);
  if (event.rawOutput !== undefined) collect(event.rawOutput);
  return parts.join("\n");
}

// Event hook & deduplication
type ToolUpdateListener = (event: AcpToolUpdateEvent) => void;
const toolUpdateListeners = new Set<ToolUpdateListener>();
const lastNotifiedSteps = new Map<string, { stepKey: string; hasInput: boolean; hasTitle: boolean; outputText: string }>();
const normalizedCommandResults = new WeakMap<AcpToolUpdateEvent, { exitCode: number | null; cleanOutput: string }>();

export function onToolUpdate(listener: ToolUpdateListener): () => void {
  toolUpdateListeners.add(listener);
  return () => {
    toolUpdateListeners.delete(listener);
  };
}

function notifyToolUpdate(event: AcpToolUpdateEvent): void {
  if (toolUpdateListeners.size === 0) return;
  const toolCallId = event.toolCallId;
  const status = event.status ?? "";
  const stepKey = `${toolCallId}:${status}`;
  const hasInput = Boolean(event.rawInput && typeof event.rawInput === "object" && Object.keys(event.rawInput).length > 0);
  const hasTitle = typeof event.title === "string" && event.title.length > 0;
  const outputText = extractEventOutputText(event);

  if (toolCallId) {
    const prev = lastNotifiedSteps.get(toolCallId);
    if (
      prev &&
      prev.stepKey === stepKey &&
      (prev.hasInput || !hasInput) &&
      (prev.hasTitle || !hasTitle) &&
      prev.outputText === outputText
    ) {
      return;
    }
    if (lastNotifiedSteps.size > 1000) {
      lastNotifiedSteps.clear();
    }
    lastNotifiedSteps.set(toolCallId, {
      stepKey,
      hasInput: Boolean(prev?.hasInput || hasInput),
      hasTitle: Boolean(prev?.hasTitle || hasTitle),
      outputText,
    });
  }

  for (const listener of toolUpdateListeners) {
    try {
      listener(event);
    } catch {
      // Ignore listener failures
    }
  }
}

// Tool name inference
function normalizeToolCandidate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (CANONICAL_ANTIGRAVITY_TOOLS.has(trimmed)) {
    return trimmed;
  }
  const underscored = trimmed.replace(/\s+/g, "_");
  if (CANONICAL_ANTIGRAVITY_TOOLS.has(underscored)) {
    return underscored;
  }
  return null;
}

export function inferAntigravityToolName(event: AcpToolUpdateEvent): string | null {
  if (!event || typeof event !== "object") return null;

  // 1. Check event._meta
  const meta = (event as Record<string, unknown>)._meta;
  if (meta && typeof meta === "object") {
    const metaObj = meta as Record<string, unknown>;
    const metaName =
      normalizeToolCandidate(metaObj.tool) ??
      normalizeToolCandidate(metaObj.name) ??
      normalizeToolCandidate(metaObj.toolName) ??
      normalizeToolCandidate(metaObj.tool_name) ??
      (metaObj["x.ai/tool"] && typeof metaObj["x.ai/tool"] === "object"
        ? normalizeToolCandidate((metaObj["x.ai/tool"] as Record<string, unknown>).name)
        : null);
    if (metaName) return metaName;
  }

  // Check event.name if present
  if (typeof event.name === "string") {
    const directName = normalizeToolCandidate(event.name);
    if (directName) return directName;
  }

  // Check event.title
  if (typeof event.title === "string") {
    const directTitle = normalizeToolCandidate(event.title);
    if (directTitle) return directTitle;

    // Check prefix before colon (e.g. "run_command: npm test" or "read_file: /path")
    const colonIndex = event.title.indexOf(":");
    if (colonIndex > 0) {
      const prefix = normalizeToolCandidate(event.title.slice(0, colonIndex));
      if (prefix) return prefix;
    }
  }

  // 2. Structural inference from event.rawInput
  const rawInput = event.rawInput as Record<string, unknown> | undefined;
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    // Has CommandLine (string) -> "run_command"
    if (typeof rawInput.CommandLine === "string" || typeof rawInput.command === "string") {
      return "run_command";
    }

    // Has TypeName and Prompt (and Role) -> "invoke_subagent"
    if (typeof rawInput.TypeName === "string" && typeof rawInput.Prompt === "string") {
      return "invoke_subagent";
    }

    // Has SystemPrompt and Name and Description -> "define_subagent"
    if (
      typeof rawInput.SystemPrompt === "string" &&
      typeof rawInput.Name === "string" &&
      typeof rawInput.Description === "string"
    ) {
      return "define_subagent";
    }

    // Has Action and (ConversationIds or Action === "kill_all") -> "manage_subagents"
    if (
      typeof rawInput.Action === "string" &&
      (Array.isArray(rawInput.ConversationIds) || rawInput.Action === "kill_all")
    ) {
      return "manage_subagents";
    }

    // Has Recipient and Message -> "send_message"
    if (typeof rawInput.Recipient === "string" && typeof rawInput.Message === "string") {
      return "send_message";
    }

    // Has Action and (TaskId or Input or ["list", "kill", "status", "send_input"].includes(Action)) -> "manage_task"
    if (
      typeof rawInput.Action === "string" &&
      (typeof rawInput.TaskId === "string" ||
        rawInput.Input !== undefined ||
        ["list", "kill", "status", "send_input"].includes(rawInput.Action))
    ) {
      return "manage_task";
    }

    // Has Prompt and (DurationSeconds or CronExpression) -> "schedule"
    if (
      typeof rawInput.Prompt === "string" &&
      (typeof rawInput.DurationSeconds === "number" || typeof rawInput.CronExpression === "string")
    ) {
      return "schedule";
    }

    // Has questions (array) -> "ask_question"
    if (Array.isArray(rawInput.questions)) {
      return "ask_question";
    }

    // Has Path and (Target or Replacement) -> "edit_file"
    if (
      typeof rawInput.Path === "string" &&
      (rawInput.Target !== undefined || rawInput.Replacement !== undefined)
    ) {
      return "edit_file";
    }

    // Has Path and Content -> "write_file"
    if (typeof rawInput.Path === "string" && rawInput.Content !== undefined) {
      return "write_file";
    }

    // Has Path and (StartLine or EndLine or ByteOffset or event.kind === "read") -> "read_file"
    if (
      typeof rawInput.Path === "string" &&
      (rawInput.StartLine !== undefined ||
        rawInput.EndLine !== undefined ||
        rawInput.ByteOffset !== undefined ||
        event.kind === "read")
    ) {
      return "read_file";
    }
  }

  return null;
}

export function mapAntigravityToolKind(toolName: string | null, fallbackKind?: AcpToolKind): AcpToolKind {
  if (!toolName) return fallbackKind ?? "other";
  switch (toolName) {
    case "run_command":
      return "execute";
    case "read_file":
    case "view_file":
    case "view_file_outline":
    case "view_code_item":
    case "list_dir":
    case "list_resources":
    case "read_resource":
      return "read";
    case "write_file":
    case "edit_file":
    case "replace_file_content":
    case "multi_replace_file_content":
      return "edit";
    case "grep_search":
    case "code_search":
    case "find_by_name":
      return "search";
    case "search_web":
    case "read_url_content":
      return "fetch";
    default:
      return fallbackKind ?? "other";
  }
}

export function toolIdentity(event: AcpToolUpdateEvent): AcpDialectToolIdentity | null {
  notifyToolUpdate(event);
  const toolName = inferAntigravityToolName(event);
  if (toolName) {
    return {
      name: toolName,
      kind: mapAntigravityToolKind(toolName, event.kind as AcpToolKind),
    };
  }
  if (typeof event.name === "string" && event.name.trim()) {
    return {
      name: event.name.trim(),
      kind: mapAntigravityToolKind(event.name.trim(), event.kind as AcpToolKind),
    };
  }
  if (event.kind) {
    return {
      kind: event.kind as AcpToolKind,
    };
  }
  return null;
}

// Output and exit code parsing
const BACKGROUND_TASK_ID_LINE = /^(?:Tool is running as a background task with task id|Background command ID):[ \t]*(.+)$/;

export function isValidBackgroundTaskId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(id);
}
const WRAPPER_TIMESTAMP_LINE = /^(?:Created|Completed) At:[ \t]*\d{4}-\d{2}-\d{2}T\S+[ \t]*$/;
export function normalizeFileUri(value: string): string {
  return value.trim().replace(/^file:\/\/\/([A-Za-z]:\/)/i, '$1').replace(/^file:\/\/\//i, '/');
}
export function structuredCommandExitCode(rawOutput: unknown): number | null {
  if (!rawOutput || typeof rawOutput !== "object") return null;
  for (const key of ["exit_code", "exitCode"]) {
    const value: unknown = Reflect.get(rawOutput, key);
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

const SAFE_OUTPUT_FILE_PATH = /^(?:file:\/\/\/|\/|[A-Za-z]:[\\/])[^\r\n"'`<>|?*]+$/;

export function parseBackgroundCommandOutput(
  event: { rawOutput?: unknown },
  text: string,
): { taskId: string; description?: string; outputFile?: string } | null {
  if (structuredCommandExitCode(event.rawOutput) !== null) return null;
  const lines = text.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed || WRAPPER_TIMESTAMP_LINE.test(trimmed)) {
      index += 1;
      continue;
    }
    break;
  }
  if (index >= lines.length) return null;
  const idMatch = BACKGROUND_TASK_ID_LINE.exec(lines[index].trim());
  if (!idMatch || !isValidBackgroundTaskId(idMatch[1])) return null;
  const taskId = idMatch[1];
  let description: string | undefined;
  let outputFile: string | undefined;
  for (let i = index + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || /^Log output:/i.test(trimmed)) break;
    if (!description) {
      const descMatch = /^Task Description:[ \t]*([^\r\n]+)$/.exec(trimmed);
      if (descMatch) {
        description = descMatch[1].trim();
        continue;
      }
    }
    if (!outputFile) {
      const fileMatch = /^Task logs are available at:[ \t]*([^\r\n]+)$/.exec(trimmed);
      if (fileMatch) {
        const candidate = fileMatch[1].trim();
        if (SAFE_OUTPUT_FILE_PATH.test(candidate)) outputFile = normalizeFileUri(candidate);
      }
    }
  }
  return {
    taskId,
    ...(description ? { description } : {}),
    ...(outputFile ? { outputFile } : {}),
  };
}

export const CLI_CANCELLATION = /Tool execution was canceled|Step was canceled|was canceled with result/i;
type TaskOutcome = 'completed' | 'failed' | 'interrupted';

export function parseTaskAnnouncements(text: string): {
  id: string;
  type: 'local_bash' | 'local_subagent';
  status: TaskOutcome;
  summary?: string;
}[] {
  const markers = [...text.matchAll(/^(?:Task id "([^"\r\n]+)" (finished with result:|was canceled|was killed|terminated|failed)|Subagent ([^\s"]+) has gone idle)/gim)];
  return markers.map((match, index) => {
    if (match[3]) return { id: match[3], type: 'local_subagent', status: 'completed' };
    const summary = text.slice(match.index + match[0].length, markers[index + 1]?.index ?? text.length).trim();
    const canceled = /was canceled|was killed|terminated/i.test(match[2]) || CLI_CANCELLATION.test(summary);
    const failed = match[2].toLowerCase() === 'failed' || /Command exited with code ([1-9]\d*)|Encountered error/i.test(summary);
    return { id: match[1], type: 'local_bash', status: canceled ? 'interrupted' : failed ? 'failed' : 'completed', summary };
  });
}

export function classifyManageTaskStatus(text: string, rawOutput?: unknown): TaskOutcome | null {
  const statusText = text.split(/^Log output:/im, 1)[0];
  if (CLI_CANCELLATION.test(statusText)) return 'interrupted';
  if (/Step is still running|status\s*[:=]\s*RUNNING\b/i.test(statusText)) return null;
  const textualCode = /Command exited with code (-?\d+)\b/i.exec(statusText);
  const exitCode = structuredCommandExitCode(rawOutput) ?? (textualCode ? Number(textualCode[1]) : null);
  if (exitCode !== null) return exitCode === 0 ? 'completed' : 'failed';
  if (/status\s*[:=]\s*(?:CANCELED|KILLED)\b/i.test(statusText)) return 'interrupted';
  if (/status\s*[:=]\s*(?:ERROR|FAILED)\b/i.test(statusText)) return 'failed';
  if (/SCHEDULE_FINISHED|status\s*[:=]\s*(?:DONE|COMPLETED|STOPPED)\b|not running|not found|unknown task|finished with result/i.test(statusText)) return 'completed';
  return null;
}

export function subagentConversationId(rawOutput: unknown, text: string): string | undefined {
  const structured = rawOutput && typeof rawOutput === 'object' && 'conversationId' in rawOutput
    ? rawOutput.conversationId : undefined;
  const spawnedId = /\bSubagent spawned\b/i.test(text) ? /\bconversationId:[ \t]*([^\s,]+)/i.exec(text)?.[1] : undefined;
  return [structured, /"conversationId"\s*:\s*"([^"]+)"/.exec(text)?.[1], spawnedId]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

export function containsTaskToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_/-])${escaped}(?![A-Za-z0-9_/-])`).test(text);
}

export function parseSubagentList(rawOutput: unknown, text: string): (id: string) => boolean {
  const empty = /no active (?:direct )?subagents/i.test(text) || /^\s*\[\s*\]\s*$/.test(text)
    || (Array.isArray(rawOutput) && rawOutput.length === 0);
  const lines = text.split('\n');
  return (id: string): boolean => {
    if (empty) return true;
    const line = lines.find(line => containsTaskToken(line, id));
    return line !== undefined && /\b(?:idle|done|completed|killed|stopped)\b/i.test(line);
  };
}

export function parseAntigravityCommandOutput(rawText: string): {
  cleanOutput: string;
  exitCode: number | null;
  isBackgrounded: boolean;
  backgroundTaskId: string | null;
} {
  if (typeof rawText !== "string") {
    return { cleanOutput: "", exitCode: null, isBackgrounded: false, backgroundTaskId: null };
  }

  const backgroundTaskId = parseBackgroundCommandOutput({}, rawText)?.taskId ?? null;

  // Diagnostic headers (e.g. "There were sandbox errors...") carry the reason a
  // command failed, and are often the only information when the output section
  // is empty. Extract them before header stripping so they survive normalization.
  const diagnosticLines: string[] = [];
  const body = rawText.replace(/^There were sandbox errors[^\r\n]*(?:\r?\n)?/gm, (line) => {
    diagnosticLines.push(line.replace(/\r?\n$/, ""));
    return "";
  });

  // Strict check for Antigravity wrapper header before "Command output:\n" or "Output:\n"
  const headerSplitMatch = body.match(
    /^(?:(?:Created At:[^\r\n]*|Completed At:[^\r\n]*|(?:The c|C)ommand exited with code -?\d+\b[^\r\n]*|The user changed the command to be run to:[^\r\n]*|This command includes call\(s\) to[^\r\n]*|[ \t]*)\r?\n)*(?:Command output|Output):\r?\n/i
  );
  const exitCodeMatch = (headerSplitMatch?.[0] ?? rawText).match(/^(?:The c|C)ommand exited with code (-?\d+)\b\.?/m);
  const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : null;

  let cleanOutput: string;
  if (headerSplitMatch) {
    cleanOutput = body.slice(headerSplitMatch[0].length);
  } else {
    cleanOutput = body
      .replace(/^Created At:[^\r\n]*(?:\r?\n)?/gm, "")
      .replace(/^Completed At:[^\r\n]*(?:\r?\n)?/gm, "")
      .replace(/^(?:The c|C)ommand exited with code -?\d+\b\.?[^\r\n]*(?:\r?\n)?/gm, "")
      .replace(/^\r?\n+/, "");
  }

  // A failed command must never normalize to an empty string: when the output
  // section is empty, surface the diagnostic text (or the exit-code line it came
  // from) so the failure reason reaches BB and the model.
  if (cleanOutput.trim() === "" && (diagnosticLines.length > 0 || (exitCode !== null && exitCode !== 0))) {
    cleanOutput =
      diagnosticLines.length > 0
        ? diagnosticLines.join("\n")
        : exitCodeMatch?.[0].trim() ?? "";
  } else if (diagnosticLines.length > 0) {
    cleanOutput = `${diagnosticLines.join("\n")}\n${cleanOutput}`;
  }

  return {
    cleanOutput,
    exitCode,
    isBackgrounded: backgroundTaskId !== null,
    backgroundTaskId,
  };
}

// Normalization & Command Result
export function normalizeCommandEvent(event: AcpToolUpdateEvent): AcpToolUpdateEvent {
  if (!event || typeof event !== "object") return event;

  let normalized: AcpToolUpdateEvent = { ...event };
  const rawInput = event.rawInput as Record<string, unknown> | undefined;

  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const updatedInput = { ...rawInput };
    if (typeof updatedInput.CommandLine === "string" && !updatedInput.command) {
      updatedInput.command = updatedInput.CommandLine;
    }
    normalized.rawInput = updatedInput;

    const cmd =
      typeof updatedInput.CommandLine === "string"
        ? updatedInput.CommandLine
        : typeof updatedInput.command === "string"
          ? updatedInput.command
          : undefined;

    if (cmd && (!normalized.title || normalized.title.trim().toLowerCase() === "run_command")) {
      normalized.title = cmd;
    }
  }

  const contentText = extractEventOutputText({ content: event.content });
  const result = readCommandOutput(event, contentText);
  const { cleanOutput } = result;
  if (contentText) {
    normalized.content = [{ type: "content", content: { type: "text", text: cleanOutput } }];
  } else if (typeof event.rawOutput === "string") {
    normalized.rawOutput = cleanOutput;
  } else if (event.rawOutput && typeof event.rawOutput === "object" && cleanOutput) {
    normalized.rawOutput = { ...event.rawOutput, stdout: cleanOutput, stderr: undefined };
  }
  normalizedCommandResults.set(normalized, result);
  return normalized;
}

export function commandOutputText(
  event: { rawOutput?: unknown; content?: unknown },
  contentText = extractEventOutputText({ content: event.content }),
): string {
  const raw = event.rawOutput;
  return contentText ||
    (raw && typeof raw === "object" && "output" in raw && typeof raw.output === "string"
      ? raw.output
      : extractEventOutputText({ rawOutput: raw }));
}

function readCommandOutput(event: AcpToolUpdateEvent, contentText?: string) {
  const { cleanOutput, exitCode } = parseAntigravityCommandOutput(commandOutputText(event, contentText));
  return { cleanOutput, exitCode: structuredCommandExitCode(event.rawOutput) ?? exitCode };
}

function commandResult(event: AcpToolUpdateEvent) {
  const { exitCode, cleanOutput } = normalizedCommandResults.get(event) ?? readCommandOutput(event);
  if (exitCode === null && !cleanOutput) return undefined;
  return {
    ...(exitCode === null ? {} : { exitCode }),
    ...(cleanOutput ? { output: cleanOutput } : {}),
  };
}

// Tool Classification
export function classifyToolCall(event: AcpToolUpdateEvent): AcpDialectToolClassification | null {
  notifyToolUpdate(event);
  const toolName = inferAntigravityToolName(event);
  if (!toolName) return null;

  const rawInput = (event.rawInput && typeof event.rawInput === "object" && !Array.isArray(event.rawInput)
    ? (event.rawInput as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  switch (toolName) {
    case "run_command": {
      const commandLine =
        typeof rawInput.CommandLine === "string"
          ? rawInput.CommandLine
          : typeof rawInput.command === "string"
            ? rawInput.command
            : undefined;
      const toolSummary =
        typeof rawInput.toolSummary === "string"
          ? rawInput.toolSummary
          : typeof rawInput.description === "string"
            ? rawInput.description
            : undefined;
      const bypassSandbox = rawInput.BypassSandbox === true;

      const outputText = commandOutputText(event);
      const isBackgrounded = parseBackgroundCommandOutput(event, outputText) !== null;

      const useToolSummary =
        typeof toolSummary === "string" &&
        toolSummary.trim().length > 0 &&
        toolSummary.trim() !== commandLine?.trim();

      const presentation: DialectPresentation = {
        label: {
          pending: "Running command",
          completed: isBackgrounded ? "Started background command" : "Ran command",
        },
        icon: { glyph: "Terminal" },
        ...(useToolSummary
          ? {
              title: toolSummary!.trim(),
              ...(commandLine
                ? {
                    detail: truncatePresentationDetail(commandLine),
                    subtitle: commandLine,
                  }
                : {}),
            }
          : {
              title: commandLine || event.title || "Command",
            }),
        ...(bypassSandbox
          ? {
              badge: {
                glyph: "ShieldAlert",
                label: "Outside of sandbox",
                hint: "Command runs outside the sandbox",
                tone: "destructive",
              },
              badges: [{ label: "Outside of sandbox", tone: "destructive" }],
            }
          : {}),
      };

      return {
        kind: "command",
        presentation,
        item: {
          type: "command",
          command: commandLine ?? "",
          cwd: "",
        },
      };
    }

    case "invoke_subagent": {
      const role =
        typeof rawInput.Role === "string" && rawInput.Role.trim() ? rawInput.Role.trim() : undefined;
      const typeName =
        typeof rawInput.TypeName === "string" && rawInput.TypeName.trim()
          ? rawInput.TypeName.trim()
          : undefined;
      const model =
        typeof rawInput.Model === "string" && rawInput.Model.trim() ? rawInput.Model.trim() : undefined;
      const workspace =
        typeof rawInput.Workspace === "string" && rawInput.Workspace.trim()
          ? rawInput.Workspace.trim()
          : undefined;
      const prompt =
        typeof rawInput.Prompt === "string" && rawInput.Prompt.trim()
          ? rawInput.Prompt.trim()
          : undefined;

      const conversationId = subagentConversationId(event.rawOutput, extractEventOutputText(event));

      const label = role || typeName || "Subagent";

      const parts: string[] = [];
      if (role && typeName && typeName !== role) {
        parts.push(typeName);
      }
      if (model && model !== "inherit") {
        parts.push(model);
      }
      if (workspace && workspace !== "inherit") {
        parts.push(workspace);
      }
      const detailParts =
        parts.length > 0
          ? parts.join(" · ")
          : (prompt ? (prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt) : null);

      const presentation: DialectPresentation = {
        label: { pending: "Running subagent", completed: "Subagent launched" },
        icon: { glyph: "Bot" },
        title: label,
        ...(detailParts
          ? {
              detail: truncatePresentationDetail(detailParts),
              subtitle: detailParts,
            }
          : {}),
      };

      return {
        kind: "delegation",
        label,
        detail: detailParts || null,
        background: true,
        ...(conversationId ? { childRef: conversationId } : {}),
        presentation,
        item: {
          type: "delegation",
          childRef: conversationId ?? event.toolCallId,
          label,
          summary: detailParts || undefined,
          background: true,
        },
      };
    }

    case "define_subagent": {
      const name =
        typeof rawInput.Name === "string" && rawInput.Name.trim() ? rawInput.Name.trim() : undefined;
      const description =
        typeof rawInput.Description === "string" && rawInput.Description.trim()
          ? rawInput.Description.trim()
          : undefined;

      const presentation: DialectPresentation = {
        label: { pending: "Defining subagent", completed: "Defined subagent" },
        icon: { glyph: "Bot" },
        title: name ? `Define subagent ${name}` : "Define subagent",
        ...(description
          ? {
              detail: truncatePresentationDetail(description),
              subtitle: description,
            }
          : {}),
      };

      return {
        kind: "tool_use",
        tool: "define_subagent",
        detail: description || name || null,
        presentation,
        item: {
          type: "tool",
          tool: "define_subagent",
          args: event.rawInput,
        },
      };
    }

    case "manage_subagents": {
      const action =
        typeof rawInput.Action === "string" ? rawInput.Action.trim() : undefined;
      const ids = Array.isArray(rawInput.ConversationIds)
        ? rawInput.ConversationIds.filter((x): x is string => typeof x === "string" && x.trim().length > 0).join(", ")
        : undefined;

      let pending = "Managing subagents";
      let completed = "Managed subagents";
      if (action === "list") {
        pending = "Listing subagents";
        completed = "Listed subagents";
      } else if (action === "kill" || action === "kill_all") {
        pending = "Stopping subagents";
        completed = "Stopped subagents";
      }

      const presentation: DialectPresentation = {
        label: { pending, completed },
        icon: { glyph: "Bot" },
        title:
          action === "list"
            ? "List subagents"
            : action === "kill" || action === "kill_all"
              ? "Stop subagents"
              : "Manage subagents",
        ...(ids
          ? {
              detail: truncatePresentationDetail(ids),
              subtitle: ids,
            }
          : {}),
      };

      return {
        kind: "tool_use",
        tool: "manage_subagents",
        detail: ids || action || null,
        presentation,
        item: {
          type: "tool",
          tool: "manage_subagents",
          args: event.rawInput,
        },
      };
    }

    case "send_message": {
      const recipient =
        typeof rawInput.Recipient === "string" && rawInput.Recipient.trim()
          ? rawInput.Recipient.trim()
          : undefined;
      const message =
        typeof rawInput.Message === "string" && rawInput.Message.trim()
          ? rawInput.Message.trim()
          : undefined;

      const presentation: DialectPresentation = {
        label: { pending: "Messaging subagent", completed: "Messaged subagent" },
        icon: { glyph: "Bot" },
        title: recipient ? `Message ${recipient}` : "Message subagent",
        ...(message
          ? {
              detail: truncatePresentationDetail(message.slice(0, 120)),
              subtitle: message.slice(0, 120),
            }
          : {}),
      };

      return {
        kind: "tool_use",
        tool: "send_message",
        detail: recipient || null,
        presentation,
        item: {
          type: "tool",
          tool: "send_message",
          args: event.rawInput,
        },
      };
    }

    case "manage_task": {
      const action =
        typeof rawInput.Action === "string" ? rawInput.Action.trim() : undefined;
      const taskId =
        typeof rawInput.TaskId === "string" && rawInput.TaskId.trim()
          ? rawInput.TaskId.trim()
          : undefined;

      let pending = "Managing background task";
      let completed = "Managed background task";
      if (action === "list") {
        pending = "Listing background tasks";
        completed = "Listed background tasks";
      } else if (action === "status") {
        pending = "Checking background task";
        completed = "Checked background task";
      } else if (action === "kill") {
        pending = "Stopping background task";
        completed = "Stopped background task";
      } else if (action === "send_input") {
        pending = "Sending input to task";
        completed = "Sent input to task";
      }

      const presentation: DialectPresentation = {
        label: { pending, completed },
        icon: { glyph: "Terminal" },
        title: taskId
          ? `${action || "Task"}: ${taskId}`
          : action
            ? `Task ${action}`
            : "Manage task",
      };

      return {
        kind: "tool_use",
        tool: "manage_task",
        detail: taskId || action || null,
        presentation,
        item: {
          type: "tool",
          tool: "manage_task",
          args: event.rawInput,
        },
      };
    }

    case "schedule": {
      const duration =
        typeof rawInput.DurationSeconds === "number" ? rawInput.DurationSeconds : undefined;
      const cron =
        typeof rawInput.CronExpression === "string" && rawInput.CronExpression.trim()
          ? rawInput.CronExpression.trim()
          : undefined;
      const prompt =
        typeof rawInput.Prompt === "string" && rawInput.Prompt.trim()
          ? rawInput.Prompt.trim()
          : undefined;

      const scheduleDesc =
        typeof cron === "string"
          ? `cron: ${cron}`
          : typeof duration === "number"
            ? `${duration}s timer`
            : undefined;

      const presentation: DialectPresentation = {
        label: { pending: "Scheduling task", completed: "Scheduled task" },
        icon: { glyph: "Clock" },
        title: scheduleDesc ? `Schedule (${scheduleDesc})` : "Schedule task",
        ...(prompt
          ? {
              detail: truncatePresentationDetail(prompt.slice(0, 120)),
              subtitle: prompt.slice(0, 120),
            }
          : {}),
      };

      return {
        kind: "tool_use",
        tool: "schedule",
        detail: scheduleDesc || prompt || null,
        presentation,
        item: {
          type: "tool",
          tool: "schedule",
          args: event.rawInput,
        },
      };
    }

    case "ask_question": {
      const presentation: DialectPresentation = {
        label: { pending: "Asking question", completed: "Asked question" },
        icon: { glyph: "HelpCircle" },
        title: "Ask question",
      };

      return {
        kind: "tool_use",
        tool: "ask_question",
        presentation,
        item: {
          type: "tool",
          tool: "ask_question",
          args: event.rawInput,
        },
      };
    }

    case "swarm": {
      const action =
        typeof rawInput.action === "string" && rawInput.action.trim()
          ? rawInput.action.trim().toLowerCase()
          : undefined;
      const name =
        typeof rawInput.name === "string" && rawInput.name.trim() ? rawInput.name.trim() : undefined;
      const titleText =
        typeof rawInput.title === "string" && rawInput.title.trim() ? rawInput.title.trim() : undefined;
      const model =
        typeof rawInput.model === "string" && rawInput.model.trim() ? rawInput.model.trim() : undefined;
      const workspace =
        typeof rawInput.workspace === "string" && rawInput.workspace.trim()
          ? rawInput.workspace.trim()
          : undefined;
      const brief =
        typeof rawInput.brief === "string" && rawInput.brief.trim() ? rawInput.brief.trim() : undefined;
      const count = typeof rawInput.n === "number" && Number.isFinite(rawInput.n) ? rawInput.n : undefined;
      const tasksCount = Array.isArray(rawInput.tasks) ? rawInput.tasks.length : undefined;

      let pending = "Updating swarm";
      let completed = "Updated swarm";
      let cardTitle = "Swarm";
      let detailParts: string | undefined;
      let glyph = "Users";

      if (action === "title") {
        pending = "Naming swarm";
        completed = "Named swarm";
        cardTitle = titleText ?? "Name swarm";
      } else if (action === "add") {
        pending = "Adding swarm worker";
        completed = "Added swarm worker";
        glyph = "Bot";
        const shardCount = tasksCount ?? (count && count > 1 ? count : undefined);
        cardTitle = name
          ? shardCount
            ? `${name} (${shardCount} workers)`
            : name
          : "Add swarm worker";
        const meta: string[] = [];
        if (model) meta.push(model);
        if (workspace && workspace !== "inherit") meta.push(workspace);
        if (brief) meta.push(brief.slice(0, 140));
        if (meta.length > 0) detailParts = meta.join(" · ");
      } else if (action === "kill") {
        pending = "Stopping swarm worker";
        completed = "Stopped swarm worker";
        glyph = "Bot";
        cardTitle = name ? `Stop ${name}` : "Stop swarm worker";
      } else if (action === "status") {
        pending = "Checking swarm status";
        completed = "Checked swarm status";
        cardTitle = "Swarm status";
      } else if (action === "models") {
        pending = "Listing swarm models";
        completed = "Listed swarm models";
        cardTitle = "Swarm models";
      } else if (action === "model") {
        pending = "Switching swarm model";
        completed = "Switched swarm model";
        glyph = "Bot";
        cardTitle = name && model ? `${name} -> ${model}` : model ? `Switch model to ${model}` : "Switch swarm model";
      } else if (action) {
        cardTitle = `Swarm ${action}`;
      }

      const presentation: DialectPresentation = {
        label: { pending, completed },
        icon: { glyph },
        title: cardTitle,
        ...(detailParts
          ? {
              detail: truncatePresentationDetail(detailParts),
              subtitle: detailParts,
            }
          : {}),
      };

      return {
        kind: "tool_use",
        tool: "swarm",
        detail: detailParts ?? cardTitle,
        presentation,
        item: {
          type: "tool",
          tool: "swarm",
          args: event.rawInput,
        },
      };
    }

    case "post_message": {
      const text =
        typeof rawInput.text === "string" && rawInput.text.trim()
          ? rawInput.text.trim()
          : typeof rawInput.message === "string" && rawInput.message.trim()
            ? rawInput.message.trim()
            : undefined;
      const channel =
        typeof rawInput.channel === "string" && rawInput.channel.trim()
          ? rawInput.channel.trim()
          : undefined;
      const firstLine = text ? text.split(/\r?\n/, 1)[0].trim() : undefined;
      const cardTitle = firstLine
        ? firstLine.length > 88
          ? `${firstLine.slice(0, 85)}...`
          : firstLine
        : channel
          ? `Post to #${channel}`
          : "Post to swarm board";

      const presentation: DialectPresentation = {
        label: { pending: "Posting to swarm board", completed: "Posted to swarm board" },
        icon: { glyph: "MessageSquare" },
        title: cardTitle,
        ...(text && text !== firstLine
          ? {
              detail: truncatePresentationDetail(text),
              subtitle: text.slice(0, 140),
            }
          : {}),
      };

      return {
        kind: "tool_use",
        tool: "post_message",
        detail: text ? truncatePresentationDetail(text) : channel ?? null,
        presentation,
        item: {
          type: "tool",
          tool: "post_message",
          args: event.rawInput,
        },
      };
    }

    case "read_board": {
      const sinceSeq =
        typeof rawInput.since_seq === "number" && Number.isInteger(rawInput.since_seq)
          ? rawInput.since_seq
          : undefined;
      const channel =
        typeof rawInput.channel === "string" && rawInput.channel.trim()
          ? rawInput.channel.trim()
          : undefined;
      const suffixParts: string[] = [];
      if (channel) suffixParts.push(`#${channel}`);
      if (sinceSeq !== undefined) suffixParts.push(`since #${sinceSeq}`);
      const cardTitle = suffixParts.length > 0 ? `Read swarm board (${suffixParts.join(", ")})` : "Read swarm board";

      const presentation: DialectPresentation = {
        label: { pending: "Reading swarm board", completed: "Read swarm board" },
        icon: { glyph: "MessageSquare" },
        title: cardTitle,
      };

      return {
        kind: "tool_use",
        tool: "read_board",
        detail: suffixParts.length > 0 ? suffixParts.join(", ") : null,
        presentation,
        item: {
          type: "tool",
          tool: "read_board",
          args: event.rawInput,
        },
      };
    }

    case "swarm_wait": {
      const presentation: DialectPresentation = {
        label: { pending: "Waiting on swarm board", completed: "Resumed from swarm board" },
        icon: { glyph: "Clock" },
        title: "Wait for swarm updates",
      };

      return {
        kind: "tool_use",
        tool: "swarm_wait",
        presentation,
        item: {
          type: "tool",
          tool: "swarm_wait",
          args: event.rawInput,
        },
      };
    }

    default:
      return null;
  }
}

// Dialect registration
export const antigravityAcpDialect: AcpDialect = {
  id: ANTIGRAVITY_ACP_DIALECT_ID,
  toolIdentity: ((event: AcpToolUpdateEvent) => toolIdentity(event) ?? undefined) as any,
  classifyToolCall: ((event: AcpToolUpdateEvent) => {
    const classified = classifyToolCall(event);
    // The bridge adds a name to timeline events before classification. Approval events
    // lack that name and need a tool item so the permission request carries the native ID.
    if (classified?.item?.type === "delegation" && event.name === undefined && event.status === undefined) {
      return { item: { type: "tool", tool: "invoke_subagent", args: event.rawInput }, presentation: classified.presentation };
    }
    return classified ?? undefined;
  }) as any,
  normalizeCommandEvent,
  commandResult,
};

let dialectRegistered = false;

export function registerAntigravityAcpDialect(): AcpDialect {
  if (!dialectRegistered) {
    try {
      experimental_registerAcpDialect(antigravityAcpDialect);
    } catch {
      // Idempotent: catch in case already registered in this or parent context
    }
    dialectRegistered = true;
  }
  return antigravityAcpDialect;
}
