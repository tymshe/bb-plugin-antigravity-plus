import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
if (!process.env.BB_ANTIGRAVITY_TASK_STATE_DIR?.trim()) {
  throw new Error('bridge-fixture.mjs requires BB_ANTIGRAVITY_TASK_STATE_DIR to point to a temp directory');
}
// Keep persisted task state isolated from the real user profile in this fixture.
const { experimental_providerBridge: bridge } = await import('../host.ts');

const enabled = process.argv[2] === 'true';
const originalWrite = process.stdout.write.bind(process.stdout);
const messages = [];
let pending = '';
process.stdout.write = chunk => {
  pending += String(chunk);
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    messages.push(JSON.parse(pending.slice(0, end)));
    pending = pending.slice(end + 1);
  }
  return true;
};
const send = (id, method, params) => bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
const wait = async predicate => {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out: ' + JSON.stringify(messages));
};
const options = { permissionMode: 'accept-edits', permissionScope: 'workspace', approvalReviewer: 'user', permissionEscalation: 'ask', providerOptions: { autoApprove: enabled, acpLaunchSpec: { displayName: 'Fake', command: process.execPath, args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))], env: {} } } };
try {
  send(1, 'initialize', { protocolVersion: 1, client: { name: 'test', version: '1' } });
  assert.ok((await wait(m => m.id === 1)).result);
  send(2, 'thread/start', { threadId: 'thread', cwd: process.cwd(), instructionMode: 'append', options });
  const started = await wait(m => m.id === 2);
  assert.ok(started.result?.providerThreadId, JSON.stringify(started));
  send(3, 'turn/start', { threadId: 'thread', providerThreadId: started.result.providerThreadId, clientRequestId: 'creq_23456789ab', input: [{ type: 'text', text: 'test' }], options });
  if (!enabled) {
    const interaction = await wait(m => m.method === 'interaction/request');
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: interaction.id, result: { decision: 'allow_once', grantedPermissions: null } }));
  }
  await wait(m => JSON.stringify(m).includes('optionId'));
  await wait(m => m.params?.deltas?.some(d => d.kind === 'turn.boundary'));
  assert.equal(messages.some(m => m.method === 'interaction/request'), !enabled);
  assert.match(JSON.stringify(messages), /yes/);
  assert.match(JSON.stringify(messages), /"type":"backgroundTask"/);
  assert.match(JSON.stringify(messages), /"familyId":"fake-session\/task-1"/);
  assert.match(JSON.stringify(messages), /"Outside of sandbox"/);

  if (enabled) {
    const subagentOptions = {
      ...options,
      providerOptions: { ...options.providerOptions, subagentsDisabled: true },
    };
    const beforeSubagent = messages.length;
    send(4, 'turn/start', {
      threadId: 'thread',
      providerThreadId: started.result.providerThreadId,
      clientRequestId: 'creq_3456789abc',
      input: [{ type: 'text', text: 'subagent-test' }],
      options: subagentOptions,
    });
    const subagentResult = await wait(m => messages.indexOf(m) >= beforeSubagent &&
      m.params?.deltas?.some(d => d.kind === 'item.textDelta'));
    assert.match(JSON.stringify(subagentResult), /\\"optionId\\":\\"no\\"/);
    await wait(m => messages.indexOf(m) >= beforeSubagent && m.params?.deltas?.some(d => d.kind === 'turn.boundary'));

    // Real end-to-end test: BypassSandbox: true with empty content MUST NOT be auto-approved under promptOnSandboxEscape
    const guardedOptions = {
      ...options,
      providerOptions: { ...options.providerOptions, autoApprove: true, promptOnSandboxEscape: true },
    };
    send(5, 'turn/start', {
      threadId: 'thread',
      providerThreadId: started.result.providerThreadId,
      clientRequestId: 'creq_456789abcd',
      input: [{ type: 'text', text: 'sandbox-escape-test' }],
      options: guardedOptions,
    });
    const escapeInteraction = await wait(
      m => m.method === 'interaction/request' && m.params?.payload?.subject?.itemId === 'escape-tool',
    );
    const beforeEscapeBoundaryCount = messages.length;
    bridge.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: escapeInteraction.id,
      result: { decision: 'deny', grantedPermissions: null },
    }));
    await wait(m => messages.indexOf(m) >= beforeEscapeBoundaryCount && m.method === 'thread/delta' && m.params?.deltas?.some(d => d.kind === 'turn.boundary'));

    // Real end-to-end negative control: synchronous command stdout mentioning background task headers must NOT open a backgroundTask.
    const beforePhantomBoundaryCount = messages.length;
    send(6, 'turn/start', {
      threadId: 'thread',
      providerThreadId: started.result.providerThreadId,
      clientRequestId: 'creq_56789abcde',
      input: [{ type: 'text', text: 'phantom-stdout-test' }],
      options,
    });
    await wait(m => m.method === 'thread/delta' && JSON.stringify(m).includes('phantom-checked'));
    await wait(m => messages.indexOf(m) >= beforePhantomBoundaryCount && m.method === 'thread/delta' && m.params?.deltas?.some(d => d.kind === 'turn.boundary'));
    const phantomDeltas = messages.slice(beforePhantomBoundaryCount)
      .flatMap(m => (m.method === 'thread/delta' && Array.isArray(m.params?.deltas) ? m.params.deltas : []));
    const phantomBg = phantomDeltas.filter(d => d.item?.type === 'backgroundTask' && (d.item.familyId === 'fake/phantom-1' || d.key?.parentRef === 'phantom-call-1'));
    assert.deepEqual(phantomBg, [], 'synchronous stdout must never register a phantom backgroundTask');

    const phantomClose = phantomDeltas.find(d => d.kind === 'item.close' && d.key?.providerItemId === 'phantom-call-1');
    assert.equal(phantomClose?.presentation?.label?.completed, 'Ran command');
    assert.equal(phantomClose.aggregatedOutput,
      'Tool is running as a background task with task id: fake/phantom-1\nTask logs are available at: /tmp/phantom.log\n');

    const thoughtIndex = phantomDeltas.findIndex(d => d.kind === 'item.textDelta' && d.text === 'phantom-reasoning');
    assert.ok(thoughtIndex > 0);
    assert.deepEqual(phantomDeltas[thoughtIndex - 1], {
      kind: 'item.textClose', key: { channel: 'assistant' }, channel: 'agentMessage',
    });
    assert.equal(phantomDeltas[thoughtIndex - 2]?.text, 'phantom-before-thought');

    // Real end-to-end Case 2 replay: run_command left in_progress at prompt end_turn opens an orphan banner without holding the turn, then settles on late update.
    const beforeOrphanCount = messages.length;
    send(7, 'turn/start', {
      threadId: 'thread',
      providerThreadId: started.result.providerThreadId,
      clientRequestId: 'creq_6789abcdef',
      input: [{ type: 'text', text: 'orphan-command-test' }],
      options,
    });
    await wait(m => m.method === 'thread/delta' && m.params?.deltas?.some(d => d.kind === 'item.open' && d.item?.type === 'backgroundTask' && d.item?.familyId === 'orphan-call-1'));
    await wait(m => messages.indexOf(m) >= beforeOrphanCount && m.method === 'thread/delta' && m.params?.deltas?.some(d => d.kind === 'turn.boundary' && d.status === 'completed'));
    const lateSettle = await wait(m => m.method === 'thread/delta' && m.params?.deltas?.some(d => d.kind === 'item.close' && d.item?.type === 'backgroundTask' && d.item?.familyId === 'orphan-call-1'));
    const closedOrphan = lateSettle.params.deltas.find(d => d.kind === 'item.close' && d.item?.type === 'backgroundTask' && d.item?.familyId === 'orphan-call-1');
    assert.equal(closedOrphan.status, 'completed');
    assert.match(closedOrphan.item.summary, /42 passed/);
  }

  originalWrite('verified\n');
  bridge.onClose?.();
} catch (error) {
  process.stderr.write(String(error.stack || error) + '\n');
  process.exitCode = 1;
  bridge.onClose?.();
}
