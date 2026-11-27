import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AgyAcpProxy, isGenericQuestionElicitation } from '../acp-proxy.ts';

// Shape captured from agy 1.5.18's ask_question tool over ACP.
const elicitation = {
  jsonrpc: '2.0', id: 7, method: 'elicitation/create',
  params: {
    sessionId: 's', toolCallId: 'call_1', mode: 'form', message: 'The agent has a question.',
    requestedSchema: { type: 'object', properties: {
      q1: { type: 'string', title: 'Which color do you prefer?', oneOf: [{ const: '1', title: 'Red' }, { const: '2', title: 'Green' }] },
      q1_other: { type: 'string', title: 'Other', description: 'Optional free-form answer to: Which color do you prefer?' },
    } },
  },
};

test('proxy drops only the fixed ask_question preamble', () => {
  const toClient = [];
  const proxy = new AgyAcpProxy({ toAgent() {}, toClient: line => toClient.push(JSON.parse(line)), store: { get() {}, set() {}, delete() {} } });
  proxy.fromAgent(JSON.stringify(elicitation));
  assert.equal('message' in toClient[0].params, false);
  assert.deepEqual(toClient[0].params.requestedSchema, elicitation.params.requestedSchema);
  assert.equal(toClient[0].id, 7);
  const custom = { ...elicitation, params: { ...elicitation.params, message: 'Pick the deploy target' } };
  assert.equal(isGenericQuestionElicitation(custom), false);
  proxy.fromAgent(JSON.stringify(custom));
  assert.equal(toClient[1].params.message, 'Pick the deploy target');
});

test('ask_question becomes a BB question card and the answer reaches agy', async t => {
  const run = promisify(execFile);
  const fixture = fileURLToPath(new URL('./question-fixture.mjs', import.meta.url));
  const stateDir = mkdtempSync(join(tmpdir(), 'native-question-state-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const env = { ...process.env, BB_ANTIGRAVITY_TASK_STATE_DIR: stateDir, BB_AGY_ACP_PROXY: '0' };
  const ask = async answers => {
    const { stdout } = await run(process.execPath, ['--experimental-strip-types', fixture, JSON.stringify(answers)], { timeout: 15000, env });
    return {
      card: JSON.parse(stdout.match(/^CARD (.*)$/m)[1]),
      agent: JSON.parse(stdout.match(/^AGENT (.*)$/m)[1]),
    };
  };
  const picked = await ask({ q1: { selected: ['2'] } });
  assert.equal(picked.card.kind, 'user_question');
  assert.deepEqual(picked.card.questions[0].options.map(o => o.label), ['Red', 'Green', 'Blue']);
  assert.equal(picked.card.questions[0].allowFreeText, true);
  assert.deepEqual(picked.agent, { action: 'accept', content: { q1: '2' } });
  const typed = await ask({ q1: { selected: [], freeText: 'Purple' } });
  assert.deepEqual(typed.agent, { action: 'accept', content: { q1_other: 'Purple' } });
});
