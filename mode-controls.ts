import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// BB exposes native modes through /plan and the permission picker.
function hideNativeMode(options: NonNullable<AvailableModel["sessionOptions"]>) {
  return options.filter(option => !(option?.id === "mode" && option.type === "select"));
}

export function presentModeControls(line: string): string {
  let message;
  try { message = JSON.parse(line); } catch { return line; }
  return presentModeControlMessage(message) ? JSON.stringify(message) : line;
}

export function presentModeControlMessage(message: any): boolean {
  let modified = false;
  for (const catalog of [message?.result?.models, message?.result?.selectedOnlyModels]) {
    if (!Array.isArray(catalog)) continue;
    for (const model of catalog) {
      if (Array.isArray(model?.sessionOptions)) {
        const options = hideNativeMode(model.sessionOptions);
        if (options.length === model.sessionOptions.length) continue;
        model.sessionOptions = options;
        modified = true;
      }
    }
  }
  for (const delta of Array.isArray(message?.params?.deltas) ? message.params.deltas : []) {
    if (delta?.kind === "extension.state" && delta.extensionKind === "bb/session-options" && Array.isArray(delta.payload?.options)) {
      const options = hideNativeMode(delta.payload.options);
      if (options.length === delta.payload.options.length) continue;
      delta.payload.options = options;
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
    let lines: string[];
    try {
      lines = transformLines(line);
    } catch (error) {
      process.stderr.write(`Antigravity bridge output transform failed: ${error instanceof Error ? error.message : String(error)}\n`);
      lines = [line];
    }
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
