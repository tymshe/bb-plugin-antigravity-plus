const SESSION_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const TURN_METHODS = new Set(["turn/start", "turn/steer"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ACP combines /plan and approval policy in a single native mode.
export function mapPromptMode(line: string, parsedLine?: unknown, nativeAutoAvailable = true): string {
  let request = parsedLine;
  if (parsedLine === undefined) {
    try { request = JSON.parse(line); } catch { return line; }
  }
  if (!isRecord(request) || typeof request.method !== "string" || !isRecord(request.params)) return line;
  const { params } = request;
  const { options } = params;
  if (!isRecord(options)) return line;
  const auto = options.permissionMode === "auto";
  if (!TURN_METHODS.has(request.method) && !(auto && SESSION_METHODS.has(request.method))) return line;

  const nativeMode = options.promptMode === "plan" ? "plan"
    : auto && nativeAutoAvailable ? "auto" : "accept-edits";
  const sessionOptions = isRecord(options.sessionOptions) ? options.sessionOptions : {};
  // The shared bridge expects Accept edits with user review for native Auto.
  const autoPolicy = auto ? {
    permissionMode: "accept-edits",
    permissionScope: "workspace",
    approvalReviewer: "user",
    permissionEscalation: typeof options.permissionEscalation === "string" ? options.permissionEscalation : "ask",
  } : {};
  return JSON.stringify({
    ...request,
    params: {
      ...params,
      options: { ...options, ...autoPolicy, sessionOptions: { ...sessionOptions, mode: nativeMode } },
    },
  });
}
