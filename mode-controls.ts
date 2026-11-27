import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// agy's native mode select (default, accept-edits, auto, plan) mixes work mode
// and approval policy. BB already offers both natively: the /plan composer
// action and the permission-mode picker, so the select is hidden and
// prompt-mode.ts derives the native mode from those two controls.
function workModes(options: NonNullable<AvailableModel["sessionOptions"]>) {
  return options.filter(option => !(option.id === "mode" && option.type === "select"));
}

export function presentModeControls(line: string): string {
  let message;
  try { message = JSON.parse(line); } catch { return line; }
  return presentModeControlMessage(message) ? JSON.stringify(message) : line;
}

export function presentModeControlMessage(message: any): boolean {
  let modified = false;
  if (Array.isArray(message?.result?.models)) {
    for (const model of [...message.result.models, ...(Array.isArray(message.result.selectedOnlyModels) ? message.result.selectedOnlyModels : [])]) {
      if (Array.isArray(model?.sessionOptions)) {
        model.sessionOptions = workModes(model.sessionOptions);
        modified = true;
      }
    }
  }
  for (const delta of Array.isArray(message?.params?.deltas) ? message.params.deltas : []) {
    if (delta?.kind === "extension.state" && delta.extensionKind === "bb/session-options" && Array.isArray(delta.payload?.options)) {
      delta.payload.options = workModes(delta.payload.options);
      modified = true;
    }
  }
  return modified;
}

// The bridge has no output hook; adapt only this dedicated bridge process's JSONL transport.
export function modeControlOutput(
  intercept?: (line: string) => boolean,
  transformLines?: (line: string) => string[],
) {
  return jsonlOutput(line => {
    if (intercept?.(line)) return [];
    const presented = presentModeControls(line);
    return transformLines ? transformLines(presented) : [presented];
  });
}

export function jsonlOutput(transformLines: (line: string) => string[]) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emit = (stream: Transform, line: string, trailingNewline: boolean) => {
    const lines = transformLines(line);
    for (const out of lines) {
      stream.push(trailingNewline ? `${out}\n` : out);
    }
  };
  return new Transform({
    transform(chunk, _encoding, done) {
      pending += decoder.write(chunk);
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        emit(this, line, true);
        pending = pending.slice(end + 1);
      }
      done();
    },
    flush(done) {
      pending += decoder.end();
      if (pending) emit(this, pending, false);
      done();
    },
  });
}
