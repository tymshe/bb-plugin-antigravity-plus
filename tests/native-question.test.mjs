import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { sessionParams, setupFakeAgy, withHost } from './host-bridge-fixture.mjs';

const agentFixture = fileURLToPath(new URL('./fake-acp-question.mjs', import.meta.url));

test('proxied ask_question shows choices and free text and returns both types of answer', { skip: process.platform === 'win32' }, async t => {
  const { root, env } = setupFakeAgy(t, agentFixture);
  await withHost({ ...env, BB_AGY_ACP_PROXY: '1' }, async ({ call, messages, reply, waitFor }) => {
    const params = sessionParams(root);
    const started = await call('thread/start', params);
    const providerThreadId = started.result?.providerThreadId;
    assert.ok(providerThreadId, JSON.stringify(started));

    for (const [clientRequestId, text, answer, prompt, content] of [
      ['creq_23456789ab', 'generic', { selected: ['2'] }, 'Which color do you prefer?', { q1: '2' }],
      ['creq_3456789abc', 'custom', { selected: [], freeText: 'Purple' }, 'Pick a color for the header.\n\nWhich color do you prefer?', { q1_other: 'Purple' }],
    ]) {
      const from = messages.length;
      const turn = await call('turn/start', { ...params, providerThreadId, clientRequestId, input: [{ type: 'text', text }] });
      assert.ok(turn.result, JSON.stringify(turn));
      const interaction = await waitFor(message => messages.indexOf(message) >= from && message.method === 'interaction/request');
      const card = interaction.params.payload;
      assert.equal(card.kind, 'user_question');
      assert.equal(card.questions.length, 1);
      const [question] = card.questions;
      assert.equal(question.id, 'q1');
      assert.equal(question.prompt, prompt);
      assert.deepEqual(question.options, [
        { value: '1', label: 'Red' }, { value: '2', label: 'Green' }, { value: '3', label: 'Blue' },
      ]);
      assert.equal(question.allowFreeText, true);
      reply(interaction.id, { kind: 'user_answer', answers: { q1: answer } });
      await waitFor(message => messages.indexOf(message) >= from && message.params?.deltas?.some(delta => delta.kind === 'turn.boundary'));
      const deltas = messages.slice(from).flatMap(message => message.params?.deltas ?? []);
      const result = deltas.find(delta => delta.text?.startsWith('elicitation-response='));
      assert.ok(result?.text);
      assert.deepEqual(JSON.parse(result.text.slice('elicitation-response='.length)), { action: 'accept', content });
    }
  });
});
