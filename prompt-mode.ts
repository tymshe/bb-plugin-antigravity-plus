// ACP combines planning and approval policy in a single native mode, derived
// here from BB's /plan action and permission mode.
//
// BB's shared ACP bridge rejects permission mode "auto", but agy 1.5.4+ has a
// native Auto session mode in which Antigravity reviews its own tool calls.
// BB Auto is handed to the bridge as Accept edits with user review, so
// anything agy still escalates reaches the user as it does in BB Auto, while
// the agy session itself is switched to its native "auto" mode.
export const NATIVE_AUTO_MODE = "auto";

const SESSION_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const TURN_METHODS = new Set(["turn/start", "turn/steer"]);

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Returns false once the agent's advertised session modes are known to lack
// "auto"; undefined while they are unknown.
export type NativeAutoAvailability = (threadId: string) => boolean | undefined;

export function mapPromptMode(line: string, parsedLine?: unknown, autoAvailable?: NativeAutoAvailability): string {
  let request: any = parsedLine;
  if (arguments.length < 2) {
    try { request = JSON.parse(line); } catch { return line; }
  }
  if (!isRecord(request)) return line;
  const isTurn = TURN_METHODS.has(request.method);
  if ((!isTurn && !SESSION_METHODS.has(request.method)) || !isRecord(request.params?.options)) return line;
  const options = request.params.options;
  const nativeAuto = options.permissionMode === "auto";
  if (!isTurn && !nativeAuto) return line;
  if (nativeAuto) {
    options.permissionMode = "accept-edits";
    options.permissionScope = "workspace";
    options.approvalReviewer = "user";
    if (typeof options.permissionEscalation !== "string") options.permissionEscalation = "ask";
  }
  // The native mode select is hidden (mode-controls.ts), so a stored
  // sessionOptions.mode is stale; BB's /plan action is the only Plan switch.
  const plan = options.promptMode === "plan";
  options.sessionOptions = {
    ...options.sessionOptions,
    mode: plan ? "plan" : nativeAuto && autoAvailable?.(request.params.threadId) !== false ? NATIVE_AUTO_MODE : "accept-edits",
  };
  return JSON.stringify(request);
}
