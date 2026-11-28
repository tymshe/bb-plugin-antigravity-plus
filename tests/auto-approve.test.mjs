import test from 'node:test';
import assert from 'node:assert/strict';
import { closeOpenAssistantStream, rememberApprovalSetting, interceptApproval, recordSandboxEscapeToolCall } from '../host.ts';
import { rememberSubagentSetting } from '../subagents.ts';

const options = (autoApprove, permissionEscalation = 'ask', extraProviderOptions = {}) => ({
  permissionMode: 'accept-edits', permissionScope: 'workspace', approvalReviewer: 'user', permissionEscalation,
  providerOptions: { autoApprove, ...extraProviderOptions },
});
function start(threadId, enabled, escalation, extraProviderOptions = {}) {
  const req = { method: 'thread/start', params: { threadId, cwd: process.cwd(), instructionMode: 'append', options: options(enabled, escalation, extraProviderOptions) } };
  rememberSubagentSetting(JSON.stringify(req), req);
  rememberApprovalSetting(req);
}
function request(threadId, payload, id = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'interaction/request', params: { threadId, payload } });
}
function approval(kind, decisions = ['allow_once', 'deny'], toolName = 'tool') {
  const extra = kind === 'command' ? { command: 'test', cwd: null, actions: [], sessionGrant: null }
    : kind === 'file_change' ? { writeScope: null, sessionGrant: null }
    : { tool: toolName, presentation: { icon: { glyph: 'terminal' }, label: { pending: 'Pending', completed: 'Done' } } };
  return { kind: 'approval', subject: { kind, itemId: 'tool', ...extra }, reason: null, availableDecisions: decisions };
}

test('approval is opt-in, isolated by thread and honors denied escalation', () => {
  start('enabled', true);
  start('disabled', false);
  start('denied', true, 'deny');
  for (const kind of ['command', 'file_change', 'tool_use']) {
    assert.equal(interceptApproval(request('enabled', approval(kind))), true);
    assert.equal(interceptApproval(request('disabled', approval(kind))), false);
    assert.equal(interceptApproval(request('denied', approval(kind))), false);
  }
  assert.equal(interceptApproval(request('enabled', approval('tool_use', ['allow_for_session']))), true);
  assert.equal(interceptApproval(request('enabled', approval('tool_use', ['deny']))), false);
  assert.equal(interceptApproval(request('enabled', approval('permission_grant'))), false);
  assert.equal(interceptApproval(request('enabled', { kind: 'user_question' })), false);
  assert.equal(interceptApproval(request('enabled', { kind: 'approval' })), false);
  assert.equal(interceptApproval('invalid'), false);
  rememberApprovalSetting({ method: 'turn/start', params: { threadId: 'enabled', providerThreadId: 'session', clientRequestId: 'creq_23456789ab', input: [], options: options(false) } });
  assert.equal(interceptApproval(request('enabled', approval('tool_use'))), false);

  // When subagentsDisabled is true and autoApprove is true:
  // - If 'deny' is available, interceptApproval intercepts to deny (returns true).
  // - If 'deny' is NOT available (only 'allow_once'), interceptApproval MUST NOT auto-approve (returns false).
  start('no-subagents', true, 'ask', { subagentsDisabled: true });
  assert.equal(interceptApproval(request('no-subagents', approval('tool_use', ['allow_once'], 'invoke_subagent'))), false);
  assert.equal(interceptApproval(request('no-subagents', approval('tool_use', ['allow_once'], 'regular_tool'))), true);
});

test('promptOnSandboxEscape surfaces sandbox escape prompts even when autoApprove is enabled', () => {
  start('guarded', true, 'ask', { promptOnSandboxEscape: true });
  start('unguarded', true, 'ask', { promptOnSandboxEscape: false });

  const escapeByReason = { ...approval('command'), reason: 'Command requested execution outside of sandbox' };
  const escapeByBadge = {
    ...approval('command'),
    subject: { ...approval('command').subject, presentation: { badges: [{ label: 'Outside of sandbox', tone: 'danger' }] } },
  };
  const ordinary = approval('command');

  assert.equal(interceptApproval(request('guarded', escapeByReason)), false);
  assert.equal(interceptApproval(request('guarded', escapeByBadge)), false);
  assert.equal(interceptApproval(request('guarded', ordinary)), true);

  assert.equal(interceptApproval(request('unguarded', escapeByReason)), true);
  assert.equal(interceptApproval(request('unguarded', escapeByBadge)), true);

  // Tracked BypassSandbox toolCallId blocks auto-approval even when payload has no reason/presentation/rawInput
  recordSandboxEscapeToolCall('tracked-escape-cmd', 'guarded');
  const trackedPayload = {
    kind: 'approval',
    subject: { kind: 'command', itemId: 'tracked-escape-cmd', command: 'sudo true', cwd: null, actions: [], sessionGrant: null },
    reason: null,
    availableDecisions: ['allow_once', 'deny'],
  };
  assert.equal(interceptApproval(request('guarded', trackedPayload)), false);

  // Out-of-workspace file_change is not auto-approved in guarded mode
  const outsideFile = {
    kind: 'approval',
    subject: { kind: 'file_change', itemId: 'outside-edit', writeScope: '/etc/hosts', sessionGrant: null },
    reason: null,
    availableDecisions: ['allow_once', 'deny'],
  };
  assert.equal(interceptApproval(request('guarded', outsideFile)), false);
  assert.equal(interceptApproval(request('unguarded', outsideFile)), true);
  for (const [writeScope, expected] of [
    ['../../.bashrc', false],
    ['../outside.txt', false],
    ['src/inside.txt', true],
  ]) {
    const relativeFile = { ...outsideFile, subject: { ...outsideFile.subject, writeScope } };
    assert.equal(interceptApproval(request('guarded', relativeFile)), expected, writeScope);
  }

  // turn/steer updates approval policy mid-thread
  rememberApprovalSetting({
    method: 'turn/steer',
    params: { threadId: 'guarded', options: options(false, 'ask', { promptOnSandboxEscape: true }) },
  });
  assert.equal(interceptApproval(request('guarded', ordinary)), false);
});


test('honors approval options when bridge request validation fails', () => {
  const methods = ['thread/start', 'thread/resume', 'turn/start'];
  for (const method of methods) {
    // These partial requests omit required fields but still carry an explicit setting.
    rememberApprovalSetting({ method, params: { threadId: method, options: options(true) } });
    assert.equal(interceptApproval(request(method, approval('command'))), true, method);
    rememberApprovalSetting({ method, params: { threadId: method, options: options(false) } });
    assert.equal(interceptApproval(request(method, approval('command'))), false, method);
  }
});

const assistant = { kind: 'item.textDelta', channel: 'agentMessage', text: 'first message' };
const thought = { kind: 'item.textDelta', channel: 'reasoningText', text: 'thinking' };
const summary = { ...thought, channel: 'reasoningSummary' };
const assistantClose = { kind: 'item.textClose', key: { channel: 'assistant' }, channel: 'agentMessage' };

test('closes the assistant stream once before reasoning across stdout batches', () => {
  const open = new Set();
  closeOpenAssistantStream('a', [assistant], open);
  assert.deepEqual(closeOpenAssistantStream('b', [thought], open), [thought]);
  assert.deepEqual(
    closeOpenAssistantStream('a', [{ kind: 'usage' }, thought, thought, assistant, summary], open),
    [{ kind: 'usage' }, assistantClose, thought, thought, assistant, assistantClose, summary],
  );
});

test('keeps SDK-emitted closes and stream boundaries without duplicates', () => {
  const open = new Set();
  const accepted = { kind: 'input.accepted', clientRequestId: 'creq_1' };
  for (const close of [assistantClose, { kind: 'turn.boundary' }, { kind: 'session.reset' }, { kind: 'session.ended' }]) {
    closeOpenAssistantStream('a', [assistant], open);
    const batch = [close, thought, summary];
    assert.equal(closeOpenAssistantStream('a', batch, open), batch);
    closeOpenAssistantStream('a', [assistant], open);
    const steerBatch = [close, accepted];
    assert.equal(closeOpenAssistantStream('a', steerBatch, open), steerBatch);
  }
});

test('closes an open assistant stream once before steered or new-turn boundaries', () => {
  const open = new Set();
  const accepted = { kind: 'input.accepted', clientRequestId: 'creq_steer' };
  const reply = { kind: 'item.textDelta', channel: 'agentMessage', text: 'after steer' };
  // Initial input.accepted with no open stream passes through unchanged
  assert.equal(closeOpenAssistantStream('a', [accepted], open).length, 1);
  // Mid-stream steer closes the open assistant message before input.accepted
  closeOpenAssistantStream('a', [assistant], open);
  assert.deepEqual(closeOpenAssistantStream('a', [accepted], open), [assistantClose, accepted]);
  // Subsequent reasoning after steer does not emit a duplicate close
  assert.deepEqual(closeOpenAssistantStream('a', [thought, reply], open), [thought, reply]);
  // Direct reply without reasoning reopens cleanly and closes on input.provider or turn.open
  assert.deepEqual(closeOpenAssistantStream('a', [{ kind: 'input.provider' }, reply], open), [assistantClose, { kind: 'input.provider' }, reply]);
  assert.deepEqual(closeOpenAssistantStream('a', [{ kind: 'turn.open' }], open), [assistantClose, { kind: 'turn.open' }]);
});
