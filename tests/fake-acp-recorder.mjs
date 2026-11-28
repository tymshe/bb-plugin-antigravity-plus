// What: a minimal fake ACP agent that records every message it receives, for the proxy process test.
// Why: proves the proxy, run as a separate process, rewrites what agy receives.
// Design notes: appends each received line to the file named in RECORD_FILE; answers only what the test needs.
import { appendFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { resolveAgyAppDataDir } from '../agy-fork.ts';

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const bridgeTest = Boolean(process.env.AGY_TEST_SPAWNS);
const sessionId = bridgeTest ? '9a6a33d2-0afa-4caa-9e67-30de71f632d5' : 'rec-session';
const appDataDir = resolveAgyAppDataDir(process.argv.slice(2));
let stepIndex = 0;
let prompts = 0;
let pendingSteerPromptId = null;
if (bridgeTest) appendFileSync(process.env.AGY_TEST_SPAWNS, appDataDir + '\n');

createInterface({ input: process.stdin }).on('line', line => {
  if (process.env.RECORD_FILE) appendFileSync(process.env.RECORD_FILE, line + '\n');
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true },
    _meta: { electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null },
  } });
  if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId } });
  if (['session/resume', 'session/load', 'session/close'].includes(m.method)) send({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'session/cancel' && pendingSteerPromptId !== null) {
    const id = pendingSteerPromptId;
    pendingSteerPromptId = null;
    send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
    return;
  }
  if (m.method === 'session/prompt') {
    if (process.env.AGY_TEST_STEER_STREAM === '1') {
      if (++prompts === 1) {
        pendingSteerPromptId = m.id;
        send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'half written reply' } },
        } });
      } else {
        send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fresh reply after steer' } },
        } });
        send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
      }
      return;
    }
    if (process.env.AGY_TEST_BUSY_ONCE === '1') {
      if (++prompts === 1) {
        send({ jsonrpc: '2.0', id: m.id, error: {
          code: -32603, message: 'executor has not processed the previous input yet',
        } });
      } else {
        send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
      }
      return;
    }
    if (bridgeTest && (++stepIndex === 1 || m.params.prompt.some(block => block.text === 'auto-checkpoint'))) {
      const path = join(appDataDir, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify({
        type: 'CHECKPOINT', status: 'DONE', step_index: stepIndex, input_tokens: 50000, output_tokens: 2000,
      }) + '\n');
      send({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId, update: { sessionUpdate: 'usage_update', used: 20000, size: 100000 },
      } });
    }
    send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
  }
});
