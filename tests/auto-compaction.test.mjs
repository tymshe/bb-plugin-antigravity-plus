import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutoCompactionTracker } from "../auto-compaction.ts";

const VALID_UUID = "9a6a33d2-0afa-4caa-9e67-30de71f632d5";

function makeTranscriptDir(root, uuid = VALID_UUID) {
  const dir = join(root, "brain", uuid, ".system_generated", "logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, "transcript.jsonl");
}

function deltaLine(threadId, deltas) {
  return JSON.stringify({ jsonrpc: "2.0", method: "thread/delta", params: { threadId, deltas } });
}

function identityNotificationLine(threadId, providerThreadId) {
  return JSON.stringify({ jsonrpc: "2.0", method: "thread/identity", params: { threadId, providerThreadId } });
}

test("an ignored manual compaction does not claim the next turn's checkpoint", t => {
  const root = mkdtempSync(join(tmpdir(), "agp-ignored-compact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transcript = makeTranscriptDir(root);
  writeFileSync(transcript, "");
  const tracker = createAutoCompactionTracker({ resolveTranscriptPath: () => transcript });
  tracker.processStdoutLine(identityNotificationLine("thr", VALID_UUID));
  tracker.handleInboundRequest({ method: "thread/compact", params: { threadId: "thr" } });
  tracker.handleInboundRequest({ method: "turn/start", params: { threadId: "thr" } });
  appendFileSync(transcript, '{"step_index":2,"type":"CHECKPOINT","status":"DONE"}\n');
  const response = JSON.parse(tracker.processStdoutLine(deltaLine("thr", [{ kind: "turn.boundary", status: "completed" }])));
  assert.equal(response.params.deltas[0].key?.providerItemId, "agy-auto-compact:2");
});

test("a shorter transcript is baselined and new checkpoints still surface", t => {
  const root = mkdtempSync(join(tmpdir(), "agp-shorter-transcript-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transcript = makeTranscriptDir(root);
  const checkpoint = step => JSON.stringify({ step_index: step, type: "CHECKPOINT", status: "DONE" }) + "\n";
  writeFileSync(transcript, checkpoint(1) + checkpoint(2));
  const tracker = createAutoCompactionTracker({ resolveTranscriptPath: () => transcript });
  tracker.processStdoutLine(identityNotificationLine("thr", VALID_UUID));
  const trigger = deltaLine("thr", [{ kind: "contextWindow", used: 10 }]);
  writeFileSync(transcript, checkpoint(1));
  assert.equal(tracker.processStdoutLine(trigger), trigger);
  appendFileSync(transcript, checkpoint(3));
  const deltas = JSON.parse(tracker.processStdoutLine(trigger)).params.deltas;
  assert.deepEqual(deltas.filter(delta => delta.kind === "item.open").map(delta => delta.key.providerItemId), ["agy-auto-compact:3"]);
});

test("a standalone compact owns the checkpoint and its token detail", t => {
  const root = mkdtempSync(join(tmpdir(), "agp-standalone-compact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transcript = makeTranscriptDir(root);
  const checkpoint = step_index => JSON.stringify({
    step_index, type: "CHECKPOINT", status: "DONE", input_tokens: 50000, output_tokens: 2000,
  }) + "\n";
  writeFileSync(transcript, checkpoint(1));
  const tracker = createAutoCompactionTracker({ resolveTranscriptPath: () => transcript });
  const send = (...deltas) => JSON.parse(tracker.processStdoutLine(deltaLine("thr", deltas))).params.deltas;
  tracker.processStdoutLine(identityNotificationLine("thr", VALID_UUID));
  tracker.handleInboundRequest({ method: "turn/start", params: { threadId: "thr", input: [{ type: "text", text: "/compact" }] } });
  const item = { type: "compaction" };
  const key = { channel: "compaction" };
  send({ kind: "item.open", key, item });
  appendFileSync(transcript, checkpoint(2));
  assert.deepEqual(send({ kind: "contextWindow", used: 20000 }).map(d => d.kind), ["contextWindow"]);

  const finished = send(
    { kind: "item.close", key, item, status: "completed" },
    { kind: "context.compacted" },
    { kind: "turn.boundary", status: "completed" },
  );
  assert.deepEqual(finished.map(d => d.kind), ["item.close", "context.compacted", "turn.boundary"]);
  assert.equal(finished[0].status, "completed");
  assert.equal(finished[0].presentation.detail, "50.0k -> 20.0k tokens");

  appendFileSync(transcript, checkpoint(3));
  assert.deepEqual(send({ kind: "turn.boundary", status: "completed" }).map(d => d.kind),
    ["item.open", "item.close", "context.compacted", "turn.boundary"]);
});

test("a manual close requires a new completed checkpoint even if there is no readable transcript", t => {
  const root = mkdtempSync(join(tmpdir(), "agp-no-checkpoint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = makeTranscriptDir(root);
  for (const transcript of [path, join(root, "missing"), root]) {
    writeFileSync(path, '{"step_index":1,"type":"CHECKPOINT","status":"DONE"}\n');
    const tracker = createAutoCompactionTracker({ resolveTranscriptPath: () => transcript });
    const send = (...deltas) => JSON.parse(tracker.processStdoutLine(deltaLine("thr", deltas))).params.deltas;
    tracker.processStdoutLine(identityNotificationLine("thr", VALID_UUID));
    tracker.handleInboundRequest({ method: "thread/compact", params: { threadId: "thr" } });
    const key = { providerItemId: "manual:1" };
    const item = { type: "compaction" };
    send({ kind: "item.open", key, item });
    appendFileSync(path, '{"step_index":2,"type":"CHECKPOINT","status":"ERROR"}\n');
    const finished = send(
      { kind: "item.close", key, item, status: "completed" },
      { kind: "context.compacted" },
      { kind: "turn.boundary", status: "completed" },
    );
    assert.equal(finished[0].status, "failed");
    assert.match(finished[0].presentation.detail, /checkpoint/i);
    assert.deepEqual(finished.map(d => d.kind), ["item.close", "turn.boundary"]);
    assert.equal(finished[1].status, "failed");
    assert.match(finished[1].error.message, /checkpoint/i);
  }
});

test("surfaces automatic CHECKPOINT entries once on contextWindow/turn.boundary and never replays historical checkpoints", () => {
  const root = mkdtempSync(join(tmpdir(), "agp-autocompact-"));
  try {
    const transcript = makeTranscriptDir(root);
    writeFileSync(
      transcript,
      `${JSON.stringify({ step_index: 100, type: "CHECKPOINT", status: "DONE", input_tokens: 4000, cache_read_tokens: 500000, output_tokens: 4200 })}\n`,
    );

    const tracker = createAutoCompactionTracker({
      resolveTranscriptPath: () => transcript,
    });

    // Resume thread: historical checkpoint #100 must be baselined and NOT replayed.
    tracker.handleInboundRequest({ method: "thread/resume", params: { threadId: "thr_1", providerThreadId: VALID_UUID } });
    const afterResume = JSON.parse(
      tracker.processStdoutLine(deltaLine("thr_1", [{ kind: "contextWindow", used: 45000, size: 1048576, estimated: false }])),
    );
    assert.equal(afterResume.params.deltas.length, 1);
    assert.equal(afterResume.params.deltas[0].kind, "contextWindow");

    // Append a new automatic compaction checkpoint mid-turn.
    appendFileSync(
      transcript,
      `${JSON.stringify({ step_index: 536, type: "PLANNER_RESPONSE", input_tokens: 2000, cache_read_tokens: 510000 })}\n` +
        `${JSON.stringify({ step_index: 537, type: "CHECKPOINT", status: "DONE", input_tokens: 3461, cache_read_tokens: 509793, output_tokens: 4954 })}\n`,
    );

    const compacted = JSON.parse(
      tracker.processStdoutLine(deltaLine("thr_1", [{ kind: "contextWindow", used: 23880, size: 1048576, estimated: false }])),
    );
    assert.deepEqual(
      compacted.params.deltas.map(d => d.kind),
      ["item.open", "item.close", "context.compacted", "contextWindow"],
    );
    const openDelta = compacted.params.deltas[0];
    assert.equal(openDelta.key.providerItemId, "agy-auto-compact:537");
    assert.deepEqual(openDelta.item, { type: "compaction" });
    assert.equal(openDelta.presentation.icon.glyph, "Archive");
    assert.equal(openDelta.presentation.label.completed, "Compacted context");
    assert.equal(openDelta.presentation.detail, "513k -> 23.9k tokens");
    assert.ok(openDelta.presentation.detail.length <= 280);

    // Subsequent turn.boundary must NOT emit step 537 a second time.
    const nextBoundary = JSON.parse(
      tracker.processStdoutLine(deltaLine("thr_1", [{ kind: "turn.boundary", status: "completed" }])),
    );
    assert.deepEqual(nextBoundary.params.deltas, [{ kind: "turn.boundary", status: "completed" }]);

    tracker.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("suppresses duplicate compaction cards during manual thread/compact while still detecting later auto-compactions", () => {
  const root = mkdtempSync(join(tmpdir(), "agp-autocompact-manual-"));
  try {
    const transcript = makeTranscriptDir(root);
    writeFileSync(transcript, "");

    const tracker = createAutoCompactionTracker({
      resolveTranscriptPath: () => transcript,
    });
    tracker.handleInboundRequest({ method: "thread/start", params: { threadId: "thr_2" } });
    // Real BB bridge emits thread/identity as a top-level JSON-RPC notification, not inside thread/delta.
    tracker.processStdoutLine(identityNotificationLine("thr_2", VALID_UUID));

    // Manual compaction writes a CHECKPOINT and BB's bridge emits context.compacted itself.
    tracker.handleInboundRequest({ method: "thread/compact", params: { threadId: "thr_2" } });
    appendFileSync(
      transcript,
      `${JSON.stringify({ step_index: 42, type: "CHECKPOINT", status: "DONE", input_tokens: 1000, cache_read_tokens: 200000, output_tokens: 3000 })}\n`,
    );

    // Mid-manual usage_update should NOT emit an auto-compaction card.
    const midManual = JSON.parse(
      tracker.processStdoutLine(deltaLine("thr_2", [{ kind: "contextWindow", used: 18000, size: 1048576, estimated: false }])),
    );
    assert.deepEqual(midManual.params.deltas.map(d => d.kind), ["contextWindow"]);

    // Bridge completes manual compaction and absorbs step 42.
    const manualDone = JSON.parse(
      tracker.processStdoutLine(deltaLine("thr_2", [{ kind: "context.compacted" }, { kind: "turn.boundary", status: "completed" }])),
    );
    assert.deepEqual(manualDone.params.deltas.map(d => d.kind), ["context.compacted", "turn.boundary"]);

    // A later automatic compaction (step 120) MUST still surface cleanly.
    appendFileSync(
      transcript,
      `${JSON.stringify({ step_index: 120, type: "CHECKPOINT", status: "DONE", input_tokens: 5000, cache_read_tokens: 510000, output_tokens: 4500 })}\n`,
    );
    const autoTurn = JSON.parse(
      tracker.processStdoutLine(deltaLine("thr_2", [{ kind: "turn.boundary", status: "completed" }])),
    );
    assert.deepEqual(
      autoTurn.params.deltas.map(d => d.kind),
      ["item.open", "item.close", "context.compacted", "turn.boundary"],
    );
    assert.equal(autoTurn.params.deltas[0].presentation.detail, "515k tokens -> 4.5k summary");

    tracker.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handles malformed UUIDs, partial lines, oversized bursts, and failed manual compaction safely", () => {
  const root = mkdtempSync(join(tmpdir(), "agp-autocompact-edge-"));
  try {
    const transcript = makeTranscriptDir(root);
    writeFileSync(transcript, "");

    let resolveCalls = 0;
    const tracker = createAutoCompactionTracker({
      maxReadBytes: 4096,
      resolveTranscriptPath: () => {
        resolveCalls += 1;
        return transcript;
      },
    });

    // Non-UUID providerThreadId must be ignored without touching disk.
    tracker.handleInboundRequest({ method: "thread/resume", params: { threadId: "thr_bad", providerThreadId: "../etc/passwd" } });
    assert.equal(resolveCalls, 0);

    // Failed manual compaction must clear manualCompactionInFlight on turn.boundary.
    tracker.handleInboundRequest({ method: "thread/start", params: { threadId: "thr_3" } });
    tracker.processStdoutLine(identityNotificationLine("thr_3", VALID_UUID));
    tracker.handleInboundRequest({ method: "thread/compact", params: { threadId: "thr_3" } });
    tracker.processStdoutLine(deltaLine("thr_3", [{ kind: "turn.boundary", status: "failed" }]));

    // Write > maxReadBytes noise followed by a valid CHECKPOINT and a partial trailing line.
    appendFileSync(
      transcript,
      `${JSON.stringify({ step_index: 1, type: "GENERIC", content: "x".repeat(6000) })}\n` +
        "not-json-at-all\n" +
        `${JSON.stringify({ step_index: 99, type: "CHECKPOINT", status: "DONE", input_tokens: 1000, cache_read_tokens: 499000, output_tokens: 3200 })}\n` +
        '{"step_index":100,"type":"CHECKP',
    );

    const detected = JSON.parse(
      tracker.processStdoutLine(deltaLine("thr_3", [{ kind: "contextWindow", used: 21000, size: 1048576, estimated: false }])),
    );
    assert.deepEqual(
      detected.params.deltas.map(d => d.kind),
      ["item.open", "item.close", "context.compacted", "contextWindow"],
    );
    assert.equal(detected.params.deltas[0].key.providerItemId, "agy-auto-compact:99");

    // Completing the partial line later detects step 100 cleanly.
    appendFileSync(
      transcript,
      'OINT","status":"DONE","input_tokens":2000,"cache_read_tokens":500000,"output_tokens":3100}\n',
    );
    const detected2 = JSON.parse(
      tracker.processStdoutLine(deltaLine("thr_3", [{ kind: "turn.boundary", status: "completed" }])),
    );
    assert.equal(detected2.params.deltas[0].key.providerItemId, "agy-auto-compact:100");

    // Stop clears thread state cleanly.
    tracker.handleInboundRequest({ method: "thread/stop", params: { threadId: "thr_3" } });
    tracker.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
