import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mapPromptMode } from '../prompt-mode.ts';
import { sessionParams, setupFakeAgy, withHost } from './host-bridge-fixture.mjs';

const agentFixture = fileURLToPath(new URL('./fake-acp-modes.mjs', import.meta.url));
const auto = { permissionMode: 'auto', permissionScope: 'workspace', approvalReviewer: 'automatic', permissionEscalation: 'ask' };

test('BB Auto reaches the bridge as Accept edits with user review and a native mode selection', () => {
  for (const method of ['thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'turn/steer']) {
    const line = JSON.stringify({ method, params: { options: { ...auto, sessionOptions: { mode: 'plan', other: 'keep' } } } });
    const options = JSON.parse(mapPromptMode(line)).params.options;
    assert.equal(options.permissionMode, 'accept-edits', method);
    assert.equal(options.approvalReviewer, 'user', method);
    assert.equal(options.permissionScope, 'workspace', method);
    assert.equal(options.permissionEscalation, 'ask', method);
    assert.deepEqual(options.sessionOptions, { mode: 'auto', other: 'keep' }, method);
  }
  const full = JSON.stringify({ method: 'thread/start', params: { options: { permissionMode: 'full' } } });
  assert.equal(mapPromptMode(full), full);
});

test('native Auto, /plan, fallback warnings, and escalations run through the real ACP bridge', { skip: process.platform === 'win32' }, async t => {
  const { root, env } = setupFakeAgy(t, agentFixture);
  const params = sessionParams(root);
  params.options.providerOptions.autoApprove = true;
  let requestNumber = 0;

  await withHost(env, async ({ call, messages, reply, waitFor }) => {
    async function open(nativeAuto) {
      params.options.providerOptions.acpLaunchSpec.args = nativeAuto ? ['acp'] : ['acp', '--no-auto'];
      const from = messages.length;
      const started = await call('thread/start', { ...params, options: { ...params.options, ...auto } });
      assert.ok(started.result?.providerThreadId, JSON.stringify(started));
      const updates = messages.slice(from).flatMap(message => message.params?.deltas ?? []);
      const state = updates.find(delta => delta.extensionKind === 'bb/session-options');
      assert.deepEqual(state?.payload.options, []);
      return { ...params, providerThreadId: started.result.providerThreadId };
    }

    async function turn(session, mode, { promptMode, ask = false, permission = auto } = {}) {
      const from = messages.length;
      const afterStart = message => messages.indexOf(message) >= from;
      const started = await call('turn/start', {
        ...session,
        options: { ...session.options, ...permission, promptMode },
        clientRequestId: 'creq_23456789a' + '23456789abc'[requestNumber++],
        input: [{ type: 'text', text: ask ? 'ask permission' : 'hello' }],
      });
      assert.ok(started.result, JSON.stringify(started));
      if (ask) {
        const interaction = await waitFor(message => afterStart(message) && (
          message.params?.payload?.kind === 'approval' ||
          message.params?.deltas?.some(delta => delta.kind === 'turn.boundary')
        ));
        assert.equal(interaction.method, 'interaction/request', 'Auto escalation must ask the user');
        reply(interaction.id, { kind: 'approval', decision: 'deny' });
      }
      await waitFor(message => afterStart(message) && message.params?.deltas?.some(delta => delta.kind === 'turn.boundary'));
      const deltas = messages.slice(from).flatMap(message => message.params?.deltas ?? []);
      assert.equal(deltas.find(delta => delta.text?.startsWith('active-mode='))?.text, 'active-mode=' + mode);
      return deltas.filter(delta => delta.kind === 'provider.warning' && delta.summary === 'Antigravity Auto is unavailable').length;
    }

    async function close(session, method) {
      assert.equal((await call(method, { ...session, intent: 'release', activeTurnId: null })).result?.ok, true);
    }

    const offered = await open(true);
    assert.equal(await turn(offered, 'auto', { ask: true }), 0);
    assert.equal(await turn(offered, 'plan', { promptMode: 'plan' }), 0);
    assert.equal(await turn(offered, 'accept-edits', { permission: params.options }), 0);
    await close(offered, 'thread/stop');

    for (const method of ['thread/stop', 'thread/discard', 'thread/stop']) {
      const unavailable = await open(false);
      assert.equal(await turn(unavailable, 'accept-edits'), 1);
      assert.equal(await turn(unavailable, 'accept-edits'), 0);
      await close(unavailable, method);
    }
  });
});
