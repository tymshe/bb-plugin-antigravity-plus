import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createBackgroundTaskTracker, normalizeFileUri, deriveTranscriptPathFromLogFile, extractToolOutputText } from '../background-tasks.ts';

const command = (id = 'conv/task-1', extra = {}) => ({ toolCallId: `call:${id}`, title: 'run_command', status: 'completed', content: [{ type: 'text', text: `Tool is running as a background task with task id: ${id}\nTask Description: build\n` }], ...extra });
const agent = (id = 'agent-1') => ({ toolCallId: `call:${id}`, title: 'invoke_subagent', status: 'completed', rawInput: { Role: 'Research' }, rawOutput: { conversationId: id } });
const manage = (title, Action, input = {}, text = '') => ({ toolCallId: 'manage', title, status: 'completed', rawInput: { Action, ...input }, content: text });
function tracker(t, options = {}) { const value = createBackgroundTaskTracker({ pollIntervalMs: 0, ...options }); t.after(() => value.dispose()); return value; }

test('legacy malformed task IDs close by their original IDs before being purged', t => {
  const path = statePath(t);
  const taskId = 'task-6650 Task Description: foo';
  const tr = tracker(t, { persistPath: path });
  writeFileSync(path, JSON.stringify({ version: 1, tasks: [{
    threadId: 't', taskId, taskType: 'local_bash', description: 'foo', parentToolCallId: 'call-1', startedAt: 1,
  }] }));
  const request = { method: 'thread/resume', params: { threadId: 't' } };
  const [close] = tr.handleInboundRequest(request);
  assert.equal(close.key.providerItemId, `task:${taskId}`);
  assert.equal(close.item.familyId, taskId);
  assert.equal(close.status, 'interrupted');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks, []);
  assert.deepEqual(tracker(t, { persistPath: path }).handleInboundRequest(request), []);
});

test('rejects malformed subagent IDs at registration without writing task state', t => {
  const path = statePath(t);
  const tr = tracker(t, { persistPath: path });
  for (const id of ['task-6650 Task Description: foo', 'agent\u0001', 'agent\nother']) {
    assert.deepEqual(tr.handleToolEventForThread('t', agent(id)), []);
  }
  assert.deepEqual(tr.getActiveTasks('t'), []);
  assert.equal(existsSync(path), false);
});

test('explicit cancellation wins over failure in task status and transcript output', t => {
  const tr = tracker(t);
  tr.handleToolEventForThread('t', command('task-1'));
  tr.handleToolEventForThread('t', command('task-2'));
  const closed = [
    ...tr.inspectTextForCompletions('t', 'Task id "task-1" failed: Encountered error. Step was canceled'),
    ...tr.handleToolEventForThread('t', manage('manage_task', 'status', { TaskId: 'task-2' },
      'Tool execution was canceled. Command exited with code 1.')),
  ];
  assert.deepEqual(closed.map(delta => [delta.status, delta.item.taskStatus]),
    [['interrupted', 'killed'], ['interrupted', 'killed']]);
});

test('file normalization, transcript derivation, and nested output extraction', () => {
  assert.equal(normalizeFileUri(' file:///C:/brain/task.log '), 'C:/brain/task.log');
  assert.equal(normalizeFileUri('file:///tmp/task.log'), '/tmp/task.log');
  assert.equal(normalizeFileUri('/tmp/task.log'), '/tmp/task.log');
  assert.equal(deriveTranscriptPathFromLogFile('C:\\brain\\.system_generated\\tasks\\task-1.log'), 'C:/brain/.system_generated/logs/transcript.jsonl');
  assert.equal(deriveTranscriptPathFromLogFile('/other.log'), null);
  assert.equal(extractToolOutputText({ toolCallId: 'x', content: [{ text: 'one' }, { content: [{ text: 'two' }] }], rawOutput: { output: 'three' } }), 'one\ntwo\nthree');
});
test('command opens with full BB shape and duplicates are ignored', t => {
  const tr = tracker(t);
  const [open] = tr.handleToolEventForThread('thread', command());
  assert.deepEqual(open, {
    kind: 'item.open', attach: 'currentOrLast', key: { providerItemId: 'task:conv/task-1', parentRef: 'call:conv/task-1' },
    item: { type: 'backgroundTask', familyId: 'conv/task-1', taskType: 'local_bash', description: 'build', status: 'pending', taskStatus: 'running', skipTranscript: false, foreground: false },
    presentation: { label: { pending: 'Running background command', completed: 'Background command finished' }, icon: { glyph: 'Terminal' }, title: 'build' },
  });
  assert.deepEqual(tr.handleToolEventForThread('thread', command()), []);
  assert.deepEqual(tr.handleToolEventForThread('thread', command('pending', { status: 'in_progress' })), []);
  const [close] = tr.clearThread('thread', true);
  assert.equal(close.status, 'interrupted'); assert.equal(close.item.taskStatus, 'stopped');
  assert.deepEqual(close.key, open.key); assert.deepEqual(close.presentation, open.presentation);
});
test('description priority and alternate command format', t => {
  const tr = tracker(t);
  for (const [input, expected] of [[{ toolSummary: 'summary', CommandLine: 'cmd' }, 'summary'], [{ toolSummary: ' ', CommandLine: 'cmd' }, 'cmd'], [{ command: 'lower' }, 'lower'], [{ Prompt: 'prompt' }, 'prompt'], [{}, 'id']]) {
    const [open] = tr.handleToolEventForThread('t', command('id', { title: 'schedule', rawInput: input, content: 'Background command ID: id' }));
    assert.equal(open.item.description, expected); tr.clearThread('t');
  }
  const [open] = tr.handleToolEventForThread('t', command('id', { kind: 'run_command', title: 'Custom title', content: 'Background command ID: id\nTask logs are available at: file:///C:/brain/.system_generated/tasks/task-1.log' }));
  assert.equal(open.item.description, 'Custom title'); assert.equal(open.item.outputFile, 'C:/brain/.system_generated/tasks/task-1.log');
});
test('native subagent detection variants and description priorities', t => {
  const tr = tracker(t);
  for (const extra of [{ rawOutput: { conversationId: 'a' } }, { content: '{"conversationId": "a"}' }, { content: 'Subagent spawned with conversationId: a' }]) {
    const [open] = tr.handleToolEventForThread('t', { toolCallId: 'call', title: 'invoke_subagent', status: 'completed', rawInput: { TypeName: 'worker' }, ...extra });
    assert.equal(open.key.providerItemId, 'subagent:a'); assert.equal(open.item.description, 'worker');
    assert.equal(open.item.taskType, 'local_subagent'); assert.equal(open.presentation.icon.glyph, 'Bot'); tr.clearThread('t');
  }
});
test('manage_task status recognizes terminal outcomes and rejects running reports', t => {
  const tr = tracker(t);
  for (const [text, status, taskStatus] of [
    ['Command exited with code 0', 'completed', 'completed'], ['Command exited with code 12', 'failed', 'failed'],
    ['Command exited with code 0\nLog output:\nBuild finished with 0 errors', 'completed', 'completed'],
    ['SCHEDULE_FINISHED', 'completed', 'completed'], ['Step was canceled', 'interrupted', 'killed'],
    ['status=ERROR', 'failed', 'failed'], ['status: FAILED', 'failed', 'failed'], ['status=KILLED', 'interrupted', 'killed'],
    ['status=STOPPED', 'completed', 'completed'], ['not running', 'completed', 'completed'], ['not found', 'completed', 'completed'],
    ['unknown task', 'completed', 'completed'], ['finished with result', 'completed', 'completed'],
  ]) {
    tr.handleToolEventForThread('t', command('id'));
    const [close] = tr.handleToolEventForThread('t', manage('manage_task', 'STATUS', { TaskId: 'id' }, text));
    assert.equal(close.status, status, text); assert.equal(close.item.taskStatus, taskStatus);
  }
  tr.handleToolEventForThread('t', command('id'));
  for (const text of ['Step is still running; Command exited with code 0', 'status=RUNNING; status=DONE', 'unrecognized']) assert.deepEqual(tr.handleToolEventForThread('t', manage('manage_task', 'status', { TaskId: 'id' }, text)), []);
  assert.equal(tr.handleToolEventForThread('t', manage('manage_task', 'kill', { TaskId: 'id' }))[0].item.taskStatus, 'killed');
});
test('list reconciliation respects thread and task type', t => {
  const tr = tracker(t);
  for (const thread of ['a', 'b']) { tr.handleToolEventForThread(thread, command('keep')); tr.handleToolEventForThread(thread, command('gone')); tr.handleToolEventForThread(thread, agent()); }
  assert.deepEqual(tr.handleToolEventForThread('a', manage('manage_task', 'list', {}, 'unrecognized')), []);
  const closed = tr.handleToolEventForThread('a', manage('manage_task', 'list', {}, '| Start Time | Task ID | Tool | Description |\nkeep'));
  assert.equal(closed.length, 1); assert.equal(closed[0].item.familyId, 'gone'); assert.equal(tr.getActiveTasks('b').length, 3);
  assert.equal(tr.handleToolEventForThread('a', manage('manage_task', 'list', {}, 'No running tasks')).length, 1);
  assert.equal(tr.getActiveTasks('a')[0].taskType, 'local_subagent');
});
test('subagent management handles selective kill, kill_all, and lists', t => {
  const tr = tracker(t);
  for (const id of ['a', 'b', 'c']) tr.handleToolEventForThread('t', agent(id));
  assert.equal(tr.handleToolEventForThread('t', manage('manage_subagents', 'kill', { ConversationIds: ['a'] }))[0].status, 'interrupted');
  assert.equal(tr.handleToolEventForThread('t', manage('manage_subagents', 'list', {}, 'b idle\nc running'))[0].item.familyId, 'b');
  assert.equal(tr.handleToolEventForThread('t', manage('manage_subagents', 'kill_all'))[0].item.familyId, 'c');
  for (const text of ['No active direct subagents', 'No active subagents', '[]']) {
    tr.handleToolEventForThread('t', agent()); assert.equal(tr.handleToolEventForThread('t', manage('manage_subagents', 'list', {}, text)).length, 1);
  }
});
test('completion announcements settle once and bound each result', t => {
  const tr = tracker(t);
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) tr.handleToolEventForThread('t', command(id));
  tr.handleToolEventForThread('t', agent('native'));
  const results = tr.inspectTextForCompletions('t', 'Task id "a" finished with result: success\nTask id "b" finished with result: Command exited with code 3\nTask id "c" was canceled\nTask id "d" failed\nTask id "e" finished with result: Step was canceled\nTask id "f" finished with result: Encountered error\nSubagent native has gone idle');
  assert.deepEqual(results.map(d => d.status), ['completed', 'failed', 'interrupted', 'failed', 'interrupted', 'failed', 'completed']);
  assert.deepEqual(tr.inspectTextForCompletions('t', 'Task id "a" terminated'), []);
  assert.equal(tr.getActiveTasks('t').length, 0);
});
test('bridge correlation consumes queued events and inspects all text fields', t => {
  const tr = tracker(t);
  tr.recordToolEvent(command('id', { status: 'in_progress' })); tr.recordToolEvent(command('id'));
  const line = JSON.stringify({ jsonrpc: '2.0', method: 'thread/delta', params: { threadId: 't', deltas: [{ key: { providerItemId: 'call:id' } }] } });
  assert.equal(JSON.parse(tr.processStdoutLine(line)[0]).params.deltas.length, 1);
  assert.equal(JSON.parse(tr.processStdoutLine(line)[0]).params.deltas[1].kind, 'item.open');
  assert.equal(JSON.parse(tr.processStdoutLine(line)[0]).params.deltas.length, 1);
  for (const field of ['delta', 'output', 'text']) {
    tr.handleToolEventForThread('t', command('id'));
    const entry = field === 'delta' ? { delta: { text: 'Task id "id" was killed' } } : { item: { [field]: 'Task id "id" was killed' } };
    const result = tr.processStdoutLine(JSON.stringify({ method: 'thread/delta', params: { threadId: 't', deltas: [entry] } }));
    assert.equal(JSON.parse(result[0]).params.deltas.at(-1).status, 'interrupted');
  }
  for (const value of ['not json', 'null', '{}']) assert.deepEqual(tr.processStdoutLine(value), [value]);
});
test('inbound stop/discard and dispose clear tracking; snapshots cannot mutate state', t => {
  const tr = tracker(t);
  for (const method of ['thread/stop', 'thread/discard']) {
    tr.handleToolEventForThread('t', command()); const snapshot = tr.getActiveTasks('t'); snapshot[0].description = 'mutated';
    assert.equal(tr.getActiveTasks('t')[0].description, 'build');
    const [close] = tr.handleInboundRequest({ method, params: { threadId: 't' } });
    assert.equal(close.kind, 'item.close'); assert.equal(close.status, 'interrupted'); assert.equal(close.item.taskStatus, 'stopped');
    assert.equal(tr.getActiveTasks('t').length, 0);
  }
  assert.deepEqual(tr.handleInboundRequest(null), []); tr.dispose(); assert.deepEqual(tr.handleToolEventForThread('t', command()), []);
});
test('polling tails only new complete JSONL records and stops after settlement', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'background-tasks-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logs = join(dir, '.system_generated', 'logs'); mkdirSync(logs, { recursive: true });
  const path = join(logs, 'transcript.jsonl'); writeFileSync(path, 'Task id "id" was killed\n');
  const received = [];
  const tr = tracker(t, { pollIntervalMs: 10, onAsyncDeltas: (thread, deltas) => received.push({ thread, deltas }) });
  tr.handleToolEventForThread('t', command('id', { content: `Background command ID: id\nTask logs are available at: ${join(dir, '.system_generated', 'tasks', 'task-1.log')}` }));
  await new Promise(r => setTimeout(r, 35)); assert.equal(received.length, 0);
  const record = JSON.stringify({ message: 'Task id "id" finished with result: success' });
  appendFileSync(path, record.slice(0, 20)); await new Promise(r => setTimeout(r, 25)); assert.equal(received.length, 0);
  appendFileSync(path, record.slice(20) + '\n');
  for (let i = 0; i < 50 && !received.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(received.length, 1); assert.equal(received[0].thread, 't'); assert.equal(received[0].deltas[0].status, 'completed');
  assert.equal(tr.getActiveTasks('t').length, 0);
  appendFileSync(path, record + '\n'); await new Promise(r => setTimeout(r, 25)); assert.equal(received.length, 1);
});
test('polling handles late transcript creation and cleans up on clear and dispose', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'background-late-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logs = join(dir, '.system_generated', 'logs'); mkdirSync(logs, { recursive: true });
  const path = join(logs, 'transcript.jsonl');
  const received = [];
  const tr = tracker(t, { pollIntervalMs: 5, onAsyncDeltas: (_, deltas) => received.push(...deltas) });
  const event = id => command(id, { content: `Background command ID: ${id}\nTask logs are available at: ${join(dir, '.system_generated', 'tasks', 'task.log')}` });
  tr.handleToolEventForThread('t', event('late'));
  await new Promise(r => setTimeout(r, 15));
  writeFileSync(path, 'Task id "late" finished with result: success\n');
  for (let i = 0; i < 50 && !received.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(received.length, 1);
  tr.handleToolEventForThread('t', event('cleared')); tr.clearThread('t');
  appendFileSync(path, 'Task id "cleared" failed\n');
  tr.handleToolEventForThread('t', event('disposed')); tr.dispose();
  appendFileSync(path, 'Task id "disposed" failed\n');
  await new Promise(r => setTimeout(r, 20)); assert.equal(received.length, 1);
  const disabled = tracker(t, { onAsyncDeltas: () => assert.fail('disabled polling fired') });
  disabled.handleToolEventForThread('t', event('disabled'));
  appendFileSync(path, 'Task id "disabled" failed\n');
  await new Promise(r => setTimeout(r, 20)); assert.equal(disabled.getActiveTasks('t').length, 1);
});
test('structured empty subagent list closes active native agents', t => {
  const tr = tracker(t); tr.handleToolEventForThread('t', agent());
  const event = { ...manage('manage_subagents', 'list'), rawOutput: [] };
  assert.equal(tr.handleToolEventForThread('t', event)[0].status, 'completed');
});

const stdout = (tr, threadId, ...deltas) => JSON.parse(tr.processStdoutLine(JSON.stringify({ method: 'thread/delta', params: { threadId, deltas } }))[0]).params.deltas;
test('short and qualified IDs settle the same task without matching prefixes in lists', t => {
  const tr = tracker(t);
  for (const action of ['status', 'kill']) {
    tr.handleToolEventForThread('t', command('conv/task-1'));
    const [close] = tr.handleToolEventForThread('t', manage('manage_task', action, { TaskId: 'task-1' }, 'Command exited with code 0'));
    assert.equal(close.item.familyId, 'conv/task-1');
    assert.equal(close.status, action === 'kill' ? 'interrupted' : 'completed');
  }
  tr.handleToolEventForThread('t', command('task-1'));
  assert.equal(tr.inspectTextForCompletions('t', 'Task id "conv/task-1" was killed')[0].item.familyId, 'task-1');
  const header = '| Start Time | Task ID | Tool | Description |\n';
  for (const listed of ['task-10', 'conv/task-10']) {
    tr.handleToolEventForThread('t', command('conv/task-1')); tr.handleToolEventForThread('t', command('conv/task-10'));
    const closed = tr.handleToolEventForThread('t', manage('manage_task', 'list', {}, header + `| now | ${listed} | run_command | build |`));
    assert.deepEqual(closed.map(d => d.item.familyId), ['conv/task-1']);
    assert.deepEqual(tr.getActiveTasks('t').map(task => task.taskId), ['conv/task-10']); tr.clearThread('t');
  }
  tr.handleToolEventForThread('t', command('conv/task-1'));
  assert.deepEqual(tr.handleToolEventForThread('t', manage('manage_task', 'list', {}, header + '| now | task-1 | run_command | build |')), []);
  for (const id of ['agent-1', 'agent-10', 'agent.x']) tr.handleToolEventForThread('t', agent(id));
  const closed = tr.handleToolEventForThread('t', manage('manage_subagents', 'list', {}, 'agent-10 idle\nagent-1 running\nagentXx idle'));
  assert.deepEqual(closed.map(d => d.item.familyId), ['agent-10']);
});
test('FIFO correlation keeps reused tool IDs and partial input isolated per thread', t => {
  const tr = tracker(t);
  const key = { providerItemId: 'shared' };
  for (const thread of ['a', 'b']) tr.recordToolEvent({ toolCallId: 'shared', title: 'run_command', status: 'in_progress', rawInput: { toolSummary: thread } });
  for (const thread of ['a', 'b']) assert.equal(stdout(tr, thread, { kind: 'item.open', key }).length, 1);
  for (const thread of ['a', 'b']) tr.recordToolEvent({ toolCallId: 'shared', status: 'completed', content: `Background command ID: ${thread}/task-1` });
  for (const thread of ['a', 'b']) {
    const deltas = stdout(tr, thread, { kind: 'item.close', key });
    assert.equal(deltas.at(-1).item.familyId, `${thread}/task-1`);
    assert.equal(deltas.at(-1).item.description, thread);
  }
  tr.inspectTextForCompletions('a', 'Task id "task-1" was killed');
  assert.equal(tr.getActiveTasks('a').length, 0); assert.equal(tr.getActiveTasks('b').length, 1);
});
test('thread-scoped fallback updates work without hooks and override unscoped events', t => {
  const tr = tracker(t);
  const entry = update => ({ kind: 'item.close', key: { providerItemId: 'shared' }, noTurnFallback: { raw: { params: { update } } } });
  for (const thread of ['a', 'b']) {
    stdout(tr, thread, entry({ toolCallId: 'shared', title: 'run_command', status: 'in_progress', rawInput: { toolSummary: thread } }));
  }
  tr.recordToolEvent(command('wrong', { toolCallId: 'shared' }));
  for (const thread of ['b', 'a']) {
    const deltas = stdout(tr, thread, entry({ toolCallId: 'shared', status: 'completed', content: `Background command ID: ${thread}/task-1` }));
    assert.equal(deltas.at(-1).item.description, thread);
    assert.equal(deltas.at(-1).item.familyId, `${thread}/task-1`);
  }
  tr.clearThread('a');
  assert.equal(stdout(tr, 'a', entry({ toolCallId: 'shared', status: 'completed', content: 'Background command ID: new' })).length, 1);
});
test('stream completion buffers span chunks, remain isolated, and flush at text close or boundary', t => {
  const tr = tracker(t);
  for (const flush of ['item.textClose', 'turn.boundary']) {
    for (const thread of ['a', 'b']) tr.handleToolEventForThread(thread, command('id'));
    for (const text of ['Task i', 'd "id" finished with result:\n', 'Command exited with code ', '1']) {
      assert.equal(stdout(tr, 'a', { kind: 'item.textDelta', text }).length, 1);
      assert.equal(tr.getActiveTasks('a').length, 1);
    }
    assert.equal(stdout(tr, 'b', { kind: flush }).length, 1);
    const deltas = stdout(tr, 'a', { kind: flush });
    assert.equal(deltas.at(-1).status, 'failed'); assert.equal(tr.getActiveTasks('b').length, 1);
    assert.equal(stdout(tr, 'a', { kind: flush }).length, 1);
    tr.clearThread('b');
  }
  tr.handleToolEventForThread('a', command('id'));
  stdout(tr, 'a', { kind: 'item.textDelta', text: 'Task id "id" failed' }); tr.clearThread('a');
  tr.handleToolEventForThread('a', command('id'));
  assert.equal(stdout(tr, 'a', { kind: 'turn.boundary' }).length, 1);
  for (const field of ['resultText', 'aggregatedOutput', 'message']) {
    tr.handleToolEventForThread('a', command(field));
    assert.equal(stdout(tr, 'a', { [field]: `Task id "${field}" failed` }).at(-1).status, 'failed');
  }
});

const statePath = t => { const dir = mkdtempSync(join(tmpdir(), 'background-state-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'background-tasks.json'); };

test('registration persists a versioned record and settling removes it', t => {
  const path = statePath(t);
  const tr = tracker(t, { persistPath: path });
  const [open] = tr.handleToolEventForThread('thread', command('task-42'));
  const file = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(file.version, 1);
  assert.equal(file.tasks.length, 1);
  const [record] = file.tasks;
  assert.equal(record.threadId, 'thread'); assert.equal(record.taskId, 'task-42'); assert.equal(record.taskType, 'local_bash');
  assert.equal(record.description, 'build'); assert.equal(record.parentToolCallId, open.key.parentRef);
  assert.ok(Number.isFinite(record.startedAt) && Math.abs(record.startedAt - Date.now()) < 60_000);
  tr.handleToolEventForThread('thread', command('task-42')); // duplicate registration does not duplicate the record
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 1);
  const [close] = tr.inspectTextForCompletions('thread', 'Task id "task-42" finished with result: success');
  assert.equal(close.status, 'completed');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 0);
});

test('simulated host restart emits interrupted close deltas on resume and drops the records', t => {
  const path = statePath(t);
  const first = tracker(t, { persistPath: path });
  first.handleToolEventForThread('thread', command('task-7'));
  first.handleToolEventForThread('thread', agent('worker-1'));
  first.handleToolEventForThread('other', command('untouched'));
  first.dispose(); // Host death: in-memory state is lost, the file keeps the records.
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 3);
  const restarted = tracker(t, { persistPath: path }); // Restarted plugin host.
  const deltas = restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread' } });
  assert.equal(deltas.length, 2);
  for (const close of deltas) {
    assert.equal(close.kind, 'item.close'); assert.equal(close.status, 'interrupted'); assert.equal(close.item.taskStatus, 'stopped');
  }
  assert.deepEqual(deltas.map(d => d.key.providerItemId).sort(), ['subagent:worker-1', 'task:task-7']);
  assert.deepEqual(deltas.map(d => d.key.parentRef).sort(), ['call:task-7', 'call:worker-1']);
  // Reconciled records drop, other threads' records survive untouched, and a second resume finds nothing.
  const file = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(file.tasks.map(r => r.threadId), ['other']);
  assert.deepEqual(restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread' } }), []);
  assert.deepEqual(restarted.handleInboundRequest({ method: 'turn/start', params: { threadId: 'thread' } }), []);
  assert.equal(restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'other' } })[0].key.providerItemId, 'task:untouched');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 0);
});

test('resume and turn/start leave tasks that are still tracked in memory alone', t => {
  const path = statePath(t);
  const tr = tracker(t, { persistPath: path });
  tr.handleToolEventForThread('t', command('live'));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 1);
  assert.deepEqual(tr.handleInboundRequest({ method: 'thread/resume', params: { threadId: 't' } }), []);
  assert.deepEqual(tr.handleInboundRequest({ method: 'turn/start', params: { threadId: 't' } }), []);
  tr.inspectTextForCompletions('t', 'Task id "live" finished with result: done');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 0);
  tr.dispose();
  const restarted = tracker(t, { persistPath: path });
  assert.deepEqual(restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 't' } }), []);
});

test('corrupt, truncated, or invalid state files degrade to empty state and get repaired', t => {
  const path = statePath(t);
  mkdirSync(dirname(path), { recursive: true });
  for (const corrupt of ['noise{{{', JSON.stringify({ version: 1, tasks: 'nope' }), JSON.stringify({ version: 2, tasks: [] }),
    JSON.stringify({ version: 1, tasks: [{ threadId: 't' }, null, 42] }), '']) {
    writeFileSync(path, corrupt);
    const tr = tracker(t, { persistPath: path }); // must not throw and must treat the file as empty
    assert.deepEqual(tr.handleInboundRequest({ method: 'thread/resume', params: { threadId: 't' } }), []);
    tr.handleToolEventForThread('t', command('ok')); // registration still works and rewrites a valid file
    const file = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(file.version, 1); assert.equal(file.tasks.length, 1); assert.equal(file.tasks[0].taskId, 'ok');
    tr.clearThread('t');
  }
});

test('stale persisted records are garbage-collected on startup and cannot reconcile', t => {
  const path = statePath(t);
  mkdirSync(dirname(path), { recursive: true });
  const record = (threadId, taskId, startedAt) => ({ threadId, taskId, taskType: 'local_bash', description: 'build', parentToolCallId: `call:${taskId}`, startedAt });
  writeFileSync(path, JSON.stringify({ version: 1, tasks: [
    record('stale', 'task-old', Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days, beyond the default max age
    record('fresh', 'task-new', Date.now() - 60_000),
  ] }));
  const tr = tracker(t, { persistPath: path }); // Startup load prunes the stale record already.
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks.map(r => r.threadId), ['fresh']);
  assert.deepEqual(tr.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'stale' } }), []);
  const [close] = tr.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'fresh' } });
  assert.equal(close.key.providerItemId, 'task:task-new'); assert.equal(close.status, 'interrupted');
});

test('stale-record max age is configurable via taskStateMaxAgeMs', t => {
  const path = statePath(t);
  const tr = tracker(t, { persistPath: path, taskStateMaxAgeMs: 0 }); // Every record is immediately stale.
  tr.handleToolEventForThread('t', command('fleeting'));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 1); // Live tasks still persist their record.
  tr.dispose();
  // Expiry must not depend on whether restart crosses a millisecond boundary.
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.tasks[0].startedAt = Date.now() - 1000;
  writeFileSync(path, JSON.stringify(state));
  const restarted = tracker(t, { persistPath: path, taskStateMaxAgeMs: 0 });
  assert.deepEqual(restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 't' } }), []);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 0);
});

// Silent turn detection: a turn that ends with a failed command with empty output and no
// agent text at all is surfaced with a synthetic agent-visible message (issue #16).
const failedEmptyCommand = (extra = {}) => ({ kind: 'item.close', status: 'failed', key: { providerItemId: 'call:failed-cmd' }, item: { type: 'command', command: 'rebuild', cwd: '' }, exitCode: 1, ...extra });
const boundary = (status = 'completed') => ({ kind: 'turn.boundary', status });
const visibleAgentText = text => ({ kind: 'item.textDelta', key: { channel: 'assistant' }, channel: 'agentMessage', text });
const injectedMessage = deltas => deltas.find(d => d.kind === 'item.textClose');
test('failed empty-output command with no agent text injects a visible message before the boundary', t => {
  const tr = tracker(t);
  const deltas = stdout(tr, 't', failedEmptyCommand(), boundary());
  assert.deepEqual(deltas.map(d => d.kind), ['item.close', 'item.textDelta', 'item.textClose', 'turn.boundary']);
  const open = deltas[1];
  const message = injectedMessage(deltas);
  assert.equal(open.channel, 'agentMessage'); assert.deepEqual(open.key, { channel: 'assistant' });
  assert.equal(open.text, message.text); assert.equal(message.channel, 'agentMessage');
  assert.match(message.text, /ended this turn without a response/);
  assert.match(message.text, /reload|restart/i);
});
test('no injection for turns without empty-output failures or with agent text', t => {
  const tr = tracker(t);
  assert.deepEqual(stdout(tr, 't', boundary()), [boundary()]);
  const noisyFailure = failedEmptyCommand({ aggregatedOutput: 'permission denied', resultText: 'permission denied' });
  assert.deepEqual(stdout(tr, 't', noisyFailure, boundary()), [noisyFailure, boundary()]);
  const completed = { ...failedEmptyCommand(), status: 'completed', exitCode: 0 };
  assert.deepEqual(stdout(tr, 't', completed, boundary()), [completed, boundary()]);
  const textTurn = [failedEmptyCommand(), visibleAgentText('I hit an error'), boundary()];
  assert.deepEqual(stdout(tr, 't', ...textTurn), textTurn);
  // reasoning-only text is not visible agent output, so it is still a silent give-up
  const thinking = { kind: 'item.textDelta', key: { channel: 'thought' }, channel: 'reasoningText', text: 'thinking only' };
  const injected = injectedMessage(stdout(tr, 't', failedEmptyCommand(), thinking, boundary()));
  assert.ok(injected); assert.match(injected.text, /without a response/);
});
test('escalation after consecutive silent turns and reset on healthy turns', t => {
  const tr = tracker(t);
  const first = injectedMessage(stdout(tr, 't', failedEmptyCommand(), boundary()));
  assert.match(first.text, /without a response|reload|restart/i);
  assert.doesNotMatch(first.text, /broken in this session/);
  const second = injectedMessage(stdout(tr, 't', failedEmptyCommand(), boundary()));
  assert.match(second.text, /broken in this session/);
  assert.match(second.text, /restart the thread runtime/i);
  const third = injectedMessage(stdout(tr, 't', failedEmptyCommand(), boundary()));
  assert.match(third.text, /3 consecutive turns/);
  // a turn with a healthy command (no failure) resets the streak
  assert.equal(stdout(tr, 't', boundary()).length, 1);
  const afterReset = injectedMessage(stdout(tr, 't', failedEmptyCommand(), boundary()));
  assert.doesNotMatch(afterReset.text, /broken in this session/);
});
test('interrupted boundaries are never injected and leave the streak intact', t => {
  const tr = tracker(t);
  assert.deepEqual(stdout(tr, 't', failedEmptyCommand(), boundary('interrupted')), [failedEmptyCommand(), boundary('interrupted')]);
  const next = injectedMessage(stdout(tr, 't', failedEmptyCommand(), boundary()));
  assert.doesNotMatch(next.text, /broken in this session/);
});
test('recorded failed run_command events with empty output also count as the silent signature', t => {
  const tr = tracker(t);
  tr.recordToolEvent({ toolCallId: 'call:empty', title: 'run_command', status: 'failed', content: [{ type: 'text', text: '   ' }] });
  assert.equal(stdout(tr, 't', { kind: 'item.close', key: { providerItemId: 'call:empty' } }).length, 1);
  const message = injectedMessage(stdout(tr, 't', boundary()));
  assert.ok(message); assert.match(message.text, /without a response/);
});
test('silent-turn tracking is isolated per thread', t => {
  const tr = tracker(t);
  stdout(tr, 'a', failedEmptyCommand(), boundary());
  const bFirst = injectedMessage(stdout(tr, 'b', failedEmptyCommand(), boundary()));
  assert.doesNotMatch(bFirst.text, /broken in this session/);
  const aSecond = injectedMessage(stdout(tr, 'a', failedEmptyCommand(), boundary()));
  assert.match(aSecond.text, /broken in this session/);
});

test('retries failed task-state writes without overwriting a same-millisecond replacement (#38 & v0.1.8)', async t => {
  const { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'agp-bg-retry-'));
  t.after(() => {
    try { chmodSync(dir, 0o700); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  const statePath = join(dir, 'background-tasks.json');
  const realNow = Date.now;
  const fixedNow = realNow();
  Date.now = () => fixedNow;
  try {
    const tr1 = tracker(t, { persistPath: statePath });
    const tr2 = tracker(t, { persistPath: statePath });

    // Force tr1's first persistence attempt to fail via a stale-free active lockfile held temporarily.
    writeFileSync(`${statePath}.lock`, 'held');
    tr1.handleToolEventForThread('thr_handoff', {
      toolCallId: 'call_old',
      title: 'run_command',
      status: 'completed',
      rawInput: { toolSummary: 'Old task' },
      rawOutput: 'Tool is running as a background task with task id: shared-task',
    });
    // Release the lock and let tr2 save a replacement at the exact same millisecond with a new parentToolCallId.
    rmSync(`${statePath}.lock`, { force: true });
    tr2.handleToolEventForThread('thr_handoff', {
      toolCallId: 'call_new',
      title: 'run_command',
      status: 'completed',
      rawInput: { toolSummary: 'Replacement task' },
      rawOutput: 'Tool is running as a background task with task id: shared-task',
    });

    // Trigger tr1 to flush its pendingWrites retry (by registering a second unrelated task).
    tr1.handleToolEventForThread('thr_other', {
      toolCallId: 'call_other',
      title: 'run_command',
      status: 'completed',
      rawInput: { toolSummary: 'Other task' },
      rawOutput: 'Tool is running as a background task with task id: other-task',
    });

    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    const handoffRecord = saved.tasks.find(r => r.threadId === 'thr_handoff' && r.taskId === 'shared-task');
    assert.ok(handoffRecord, 'replacement record should exist');
    assert.equal(handoffRecord.parentToolCallId, 'call_new');
    assert.equal(handoffRecord.description, 'Replacement task');
    assert.ok(saved.tasks.some(r => r.threadId === 'thr_other' && r.taskId === 'other-task'));
  } finally {
    Date.now = realNow;
  }
});

test('coordinates concurrent host processes sharing background-tasks.json without losing writes (#32)', async t => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'agp-bg-concurrent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'background-tasks.json');
  const moduleUrl = new URL('../background-tasks.ts', import.meta.url).href;

  const runWorker = (workerName) => new Promise((resolve, reject) => {
    const script = `
      import { createBackgroundTaskTracker } from ${JSON.stringify(moduleUrl)};
      const tr = createBackgroundTaskTracker({ persistPath: ${JSON.stringify(statePath)}, pollIntervalMs: 0 });
      for (let i = 0; i < 12; i += 1) {
        tr.handleToolEventForThread(${JSON.stringify(workerName)} + '-' + i, {
          toolCallId: 'call-' + i,
          title: 'run_command',
          status: 'completed',
          rawInput: { toolSummary: 'Work ' + i },
          rawOutput: 'Tool is running as a background task with task id: task-' + i,
        });
      }
      tr.dispose();
    `;
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`worker ${workerName} exited ${code}: ${stderr}`)));
  });

  await Promise.all([runWorker('hostA'), runWorker('hostB')]);
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  const threadIds = new Set(saved.tasks.map(r => r.threadId));
  for (let i = 0; i < 12; i += 1) {
    assert.ok(threadIds.has(`hostA-${i}`), `missing hostA-${i}`);
    assert.ok(threadIds.has(`hostB-${i}`), `missing hostB-${i}`);
  }
});

test('drains large transcript bursts in bounded chunks and still settles late completions (#33)', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'agp-bg-bounded-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const tasksDir = join(dir, '.system_generated', 'tasks');
  const logsDir = join(dir, '.system_generated', 'logs');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  const logFile = join(tasksDir, 'task-burst.log');
  const transcript = join(logsDir, 'transcript.jsonl');
  writeFileSync(transcript, '');

  const settled = [];
  const tr = tracker(t, {
    pollIntervalMs: 25,
    maxTranscriptReadBytes: 2048,
    onAsyncDeltas: (_threadId, deltas) => settled.push(...deltas),
  });
  tr.handleToolEventForThread('thr_burst', {
    toolCallId: 'call_burst',
    title: 'run_command',
    status: 'completed',
    rawInput: { toolSummary: 'Long build' },
    rawOutput: `Tool is running as a background task with task id: burst-1\nTask logs are available at: ${logFile}`,
  });

  // Append >20 KiB of noisy lines followed by the completion announcement so multiple bounded reads are required.
  const noiseLine = `${JSON.stringify({ content: 'x'.repeat(1500) })}\n`;
  appendFileSync(
    transcript,
    noiseLine.repeat(16) +
      `${JSON.stringify({ content: 'Task id "burst-1" finished with result:\nCommand exited with code 0' })}\n`,
  );

  const deadline = Date.now() + 2000;
  while (!settled.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(settled.length, 1);
  assert.equal(settled[0].kind, 'item.close');
  assert.equal(settled[0].status, 'completed');
  assert.equal(tr.getActiveTasks('thr_burst').length, 0);
});

test('ignores background-task strings appearing inside ordinary command stdout and persists nothing', t => {
  const path = statePath(t);
  const tr = tracker(t, { persistPath: path });
  const phantomSamples = [
    // Real captured PR #31 description printed by `gh pr view`
    {
      toolCallId: 'call_gh_pr',
      title: 'run_command',
      status: 'completed',
      rawInput: { CommandLine: 'gh pr view 31', toolSummary: 'Read upstream PR #31' },
      content: [{ type: 'text', text: 'Command exited with code 0.\n\nCommand output:\nCase 1: `run_command` returns `Tool is running as a background task with task id: …` (already tracked).\n' }],
      rawOutput: { exit_code: 0, output: 'Command exited with code 0.\n\nCommand output:\nCase 1: `run_command` returns `Tool is running as a background task with task id: …` (already tracked).\n' },
    },
    // Real captured source code / git diff of background-tasks.ts
    {
      toolCallId: 'call_git_diff',
      title: 'run_command',
      status: 'completed',
      rawInput: { CommandLine: 'git diff background-tasks.ts', toolSummary: 'Inspect background-tasks diff' },
      content: [{ type: 'text', text: '+const id = /Tool is running as a background task with task id:[ \\t]*([^\\s\\r\\n][^\\r\\n]*)/.exec(text)?.[1], /Background command ID:[ \\t]*([^\\s\\r\\n][^\\r\\n]*)/.exec(text)?.[1];\n+const outputFile = /Task logs are available at:[ \\t]*([^\\s\\r\\n][^\\r\\n]*)/.exec(text)?.[1];\n' }],
    },
    // Real captured transcript search output containing an older task header mid-stdout
    {
      toolCallId: 'call_transcript_search',
      title: 'run_command',
      status: 'completed',
      rawInput: { CommandLine: 'python3 search_transcript.py', toolSummary: 'Search transcript' },
      content: [{ type: 'text', text: '122 MODEL PLANNER_RESPONSE\n123 MODEL GENERIC Created At: 2026-11-22T12:46:19+01:00\nTool is running as a background task with task id: 0c200d48-3c60-487c-a227-27311f641272/task-123\nTask Description: bb thread list\n' }],
    },
    // Real captured JSON dump of background-tasks.json
    {
      toolCallId: 'call_cat_state',
      title: 'run_command',
      status: 'completed',
      rawInput: { CommandLine: 'cat background-tasks.json', toolSummary: 'Inspect task state' },
      content: [{ type: 'text', text: '{"version":1,"tasks":[{"taskId":"fake/task-1","note":"Background command ID: escaped\\\\nline"}]}' }],
    },
    // Exited command whose raw stdout happens to start with a valid-looking background header
    {
      toolCallId: 'call_echo_header',
      title: 'run_command',
      status: 'completed',
      rawInput: { CommandLine: 'echo "Tool is running as a background task with task id: conv/fake"', toolSummary: 'Echo header' },
      content: [{ type: 'text', text: 'Tool is running as a background task with task id: conv/fake\n' }],
      rawOutput: { exit_code: 0, output: 'Tool is running as a background task with task id: conv/fake\n' },
    },
    // Same with stringified exit_code
    {
      toolCallId: 'call_echo_header_str_exit',
      title: 'run_command',
      status: 'completed',
      rawInput: { CommandLine: 'echo "Tool is running as a background task with task id: conv/fake2"', toolSummary: 'Echo header string exit' },
      content: [{ type: 'text', text: 'Tool is running as a background task with task id: conv/fake2\n' }],
      rawOutput: { exit_code: '0', output: 'Tool is running as a background task with task id: conv/fake2\n' },
    },
  ];

  for (const sample of phantomSamples) {
    assert.deepEqual(tr.handleToolEventForThread('thr_phantom', sample), [], `should ignore phantom ${sample.toolCallId}`);
  }
  assert.equal(tr.getActiveTasks('thr_phantom').length, 0);
  assert.equal(existsSync(path), false);

  // Positive control: genuine anchored agy background-task wrapper (with optional Created At header) still registers.
  const realDeltas = tr.handleToolEventForThread('thr_phantom', {
    toolCallId: 'call_real_bg',
    title: 'run_command',
    status: 'completed',
    rawInput: { CommandLine: 'npm run build', toolSummary: 'Build bundle' },
    content: [{
      type: 'text',
      text: 'Created At: 2026-11-26T09:09:14+01:00\nTool is running as a background task with task id: 9a6a33d2-0afa-4caa-9e67-30de71f632d5/task-1898\nTask Description: Build bundle\nTask logs are available at: file:///tmp/.system_generated/tasks/task-1898.log\nLog output:\nTask logs are available at: /fake/spoofed.log\n',
    }],
  });
  assert.equal(realDeltas.length, 1);
  assert.equal(realDeltas[0].item.familyId, '9a6a33d2-0afa-4caa-9e67-30de71f632d5/task-1898');
  assert.equal(realDeltas[0].item.outputFile, '/tmp/.system_generated/tasks/task-1898.log');
  assert.equal(tr.getActiveTasks('thr_phantom').length, 1);
});

test('tracks orphan run_command left in progress at turn end without holding the turn boundary', t => {
  const path = statePath(t);
  const tr = tracker(t, { persistPath: path });
  const call = 'call:e2e';
  const openCmd = {
    kind: 'item.open',
    key: { providerItemId: call },
    item: { type: 'command', command: 'npm run e2e', cwd: '' },
    noTurnFallback: {
      raw: {
        params: {
          update: {
            toolCallId: call,
            title: 'run_command',
            status: 'in_progress',
            rawInput: { CommandLine: 'npm run e2e', toolSummary: 'Run e2e suite' },
          },
        },
      },
    },
  };
  stdout(tr, 't', openCmd);

  // Bridge force-closes the still-running call on prompt end_turn and emits turn.boundary.
  const flushed = stdout(
    tr,
    't',
    { kind: 'item.close', status: 'completed', key: { providerItemId: call }, item: { type: 'command', command: 'npm run e2e', cwd: '' } },
    boundary(),
  );
  assert.ok(flushed.some(d => d.kind === 'turn.boundary' && d.status === 'completed'), 'turn boundary must pass through unheld');
  const bgOpen = flushed.find(d => d.item?.type === 'backgroundTask' && d.kind === 'item.open');
  assert.ok(bgOpen, 'orphan background banner should open');
  assert.equal(bgOpen.item.familyId, call);
  assert.equal(bgOpen.item.description, 'Run e2e suite');
  assert.equal(bgOpen.key.parentRef, call);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks.map(r => r.taskId), [call], 'orphan must persist while active');

  assert.deepEqual(tr.handleToolEventForThread('t', manage('manage_task', 'list', {}, 'No running tasks')), []);
  assert.equal(tr.getActiveTasks('t').length, 1, 'CLI task listing cannot see a synthetic orphan');

  // Flood >140 unrelated tool calls to confirm MAX_RETAINED_TOOLS_PER_THREAD preserves active orphan metadata.
  for (let i = 0; i < 140; i += 1) {
    const id = `call:noise-${i}`;
    stdout(tr, 't', {
      kind: 'item.close',
      status: 'completed',
      key: { providerItemId: id },
      noTurnFallback: { raw: { params: { update: { toolCallId: id, title: 'read_file', status: 'completed', rawOutput: 'ok' } } } },
    });
  }

  // Late updates settle the orphan and remove its state record.
  for (const [commandOutput, toolStatus, expectedStatus, expectedTaskStatus] of [
    ['42 passed\nCommand exited with code 1.', 'completed', 'completed', 'completed'],
    ['42 passed\n' + 'x'.repeat(5000), 'completed', 'completed', 'completed'],
    ['was canceled with result: Tool execution was canceled', 'failed', 'interrupted', 'killed'],
  ]) {
    if (!tr.getActiveTasks('t').length) {
      stdout(tr, 't', openCmd, { kind: 'item.close', status: 'completed', key: { providerItemId: call } }, boundary());
    }
    const wrappedOutput = `Created At: 2026-11-26T09:09:14+01:00\nCommand output:\n${commandOutput}`;
    const update = {
      toolCallId: call,
      title: 'run_command',
      status: toolStatus,
      content: [{ type: 'text', text: wrappedOutput }],
      rawOutput: { exit_code: 0, output: wrappedOutput },
    };
    const settled = stdout(tr, 't', {
      kind: 'item.close',
      status: 'completed',
      key: { providerItemId: call },
      noTurnFallback: { raw: { params: { update } } },
    });
    const bgClose = settled.find(d => d.item?.type === 'backgroundTask' && d.kind === 'item.close');
    assert.ok(bgClose);
    assert.equal(bgClose.status, expectedStatus);
    assert.equal(bgClose.item.taskStatus, expectedTaskStatus);
    assert.equal(bgClose.item.summary, commandOutput.slice(0, 4096));
    assert.equal(tr.getActiveTasks('t').length, 0);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks, []);
  }

  stdout(tr, 'limited', openCmd);
  const stopped = stdout(
    tr,
    'limited',
    { kind: 'item.close', status: 'completed', key: { providerItemId: call } },
    { kind: 'provider.warning', summary: 'The agent reached its output limit' },
    boundary(),
  );
  assert.equal(stopped.some(d => d.item?.type === 'backgroundTask'), false);
  assert.deepEqual(tr.getActiveTasks('limited'), []);

  // thread/compact also reconciles persisted tasks left behind after a host restart.
  stdout(tr, 'c', openCmd);
  stdout(tr, 'c', { kind: 'item.close', status: 'completed', key: { providerItemId: call } }, boundary());
  tr.dispose();
  const restarted = tracker(t, { persistPath: path });
  const compactClosed = restarted.handleInboundRequest({ method: 'thread/compact', params: { threadId: 'c' } });
  assert.equal(compactClosed.length, 1);
  assert.equal(compactClosed[0].status, 'interrupted');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks, []);

  // Failing late result and non-command / interrupted flushes.
  const tr2 = tracker(t);
  stdout(tr2, 'f', openCmd);
  stdout(tr2, 'f', { kind: 'item.close', status: 'completed', key: { providerItemId: call } }, boundary());
  const failed = stdout(tr2, 'f', {
    kind: 'item.close',
    status: 'failed',
    key: { providerItemId: call },
    noTurnFallback: { raw: { params: { update: { toolCallId: call, title: 'run_command', status: 'completed', content: 'Command exited with code 2' } } } },
  });
  assert.equal(failed.find(d => d.item?.type === 'backgroundTask')?.status, 'failed');

  stdout(tr2, 'n', { kind: 'item.open', key: { providerItemId: 'read' }, noTurnFallback: { raw: { params: { update: { toolCallId: 'read', title: 'view_file', status: 'in_progress', rawInput: { Path: 'a' } } } } } });
  stdout(tr2, 'n', { kind: 'item.close', status: 'completed', key: { providerItemId: 'read' } }, boundary());
  assert.equal(tr2.getActiveTasks('n').length, 0);

  stdout(tr2, 'i', openCmd);
  stdout(tr2, 'i', { kind: 'item.close', status: 'interrupted', key: { providerItemId: call } });
  assert.equal(tr2.getActiveTasks('i').length, 0);
});

test('startup leaves missing and healthy persisted state untouched', t => {
  const path = join(dirname(statePath(t)), 'absent', 'background-tasks.json');
  tracker(t, { persistPath: path });
  assert.equal(existsSync(dirname(path)), false);

  mkdirSync(dirname(path));
  const contents = '  {"version":1,"tasks":[]}  ';
  writeFileSync(path, contents);
  tracker(t, { persistPath: path });
  assert.equal(readFileSync(path, 'utf8'), contents);
});

test('dispose retries a pending settlement after a lock race', t => {
  const path = statePath(t);
  const tr = tracker(t, { persistPath: path });
  tr.handleToolEventForThread('t', command('task-1'));
  writeFileSync(`${path}.lock`, 'held');
  assert.equal(tr.clearThread('t', true).length, 1);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 1);
  rmSync(`${path}.lock`);
  tr.dispose();
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks, []);
});

test('a failed state rename removes its temporary file', t => {
  const path = statePath(t);
  mkdirSync(path);
  const tr = tracker(t, { persistPath: path });
  tr.handleToolEventForThread('t', command('task-1'));
  assert.deepEqual(readdirSync(dirname(path)), ['background-tasks.json']);
  tr.dispose();
  assert.deepEqual(readdirSync(dirname(path)), ['background-tasks.json']);
});

test('pending events for one tool retain the latest 32 in order', t => {
  const tr = tracker(t);
  for (let i = 0; i < 80; i += 1) {
    tr.recordToolEvent(command(`task-${i}`, { toolCallId: 'same-call' }));
  }
  const events = Array.from({ length: 33 }, () => ({
    kind: 'item.close', status: 'completed', key: { providerItemId: 'same-call' },
  }));
  const opens = stdout(tr, 't', ...events).filter(d => d.item?.type === 'backgroundTask');
  assert.deepEqual(opens.map(d => d.item.familyId),
    Array.from({ length: 32 }, (_, i) => `task-${48 + i}`));
});

test('polling settles a task announced at the start of an oversized transcript line', async t => {
  const dir = dirname(statePath(t));
  const generated = join(dir, '.system_generated');
  const logs = join(generated, 'logs');
  mkdirSync(logs, { recursive: true });
  const transcript = join(logs, 'transcript.jsonl');
  writeFileSync(transcript, '');
  const settled = [];
  const tr = tracker(t, {
    pollIntervalMs: 5,
    maxTranscriptReadBytes: 16 * 1024,
    onAsyncDeltas: (_thread, deltas) => settled.push(...deltas),
  });
  tr.handleToolEventForThread('t', command('conv/task-1', {
    content: `Background command ID: conv/task-1\nTask logs are available at: ${join(generated, 'tasks', 'task-1.log')}`,
  }));
  appendFileSync(transcript, JSON.stringify({
    text: 'Task id "conv/task-1" finished with result: ' + 'x'.repeat(350 * 1024) + 'tail-marker',
  }) + '\n');
  for (let i = 0; i < 80 && !settled.length; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, 'completed');
  assert.match(settled[0].item.summary, /tail-marker/);
});

test('command stdout cannot open or close tasks through tool results, command cards or transcript tails', async t => {
  const generated = join(dirname(statePath(t)), '.system_generated');
  const logs = join(generated, 'logs');
  mkdirSync(logs, { recursive: true });
  const transcript = join(logs, 'transcript.jsonl');
  writeFileSync(transcript, '');
  const settled = [];
  const tr = tracker(t, { pollIntervalMs: 5, onAsyncDeltas: (_, deltas) => settled.push(...deltas) });
  const register = id => tr.handleToolEventForThread('t', command(id, {
    content: 'Background command ID: ' + id + '\nTask logs are available at: ' + join(generated, 'tasks', id + '.log'),
  }));
  register('active');
  register('poll-sentinel');
  tr.handleToolEventForThread('t', agent('native'));

  const corpus = [
    ['rg Task transcript.jsonl', 'logs/transcript.jsonl:39: Task id "active" was killed\nlogs/transcript.jsonl:42: Subagent native has gone idle'],
    ['cat transcript.jsonl', JSON.stringify({ type: 'GENERIC', text: 'Task id "active" failed\nSubagent native has gone idle' })],
    ['gh pr view', 'Background command ID: phantom\n\nTask id "active" was killed\nSubagent native has gone idle'],
    ['cat background-tasks.json', JSON.stringify({ version: 1, tasks: [{ taskId: 'active', description: 'Task id "active" failed' }] })],
    ['cat background-tasks.ts', 'const warning = \'Task id "active" failed\';\n// Subagent native has gone idle'],
  ];
  for (const [commandLine, text] of corpus) {
    const wrapped = 'Command exited with code 0.\nCommand output:\n' + text;
    assert.deepEqual(tr.handleToolEventForThread('t', command('stdout', {
      rawInput: { CommandLine: commandLine }, rawOutput: { exit_code: 0, output: wrapped }, content: wrapped,
    })), [], commandLine);
    const close = {
      kind: 'item.close', status: 'completed', key: { providerItemId: 'stdout' },
      item: { type: 'command', command: commandLine, output: text, text },
      aggregatedOutput: text, resultText: text, delta: { text },
    };
    const snapshot = { kind: 'command.outputSnapshot', key: close.key, text };
    assert.deepEqual(stdout(tr, 't', close, snapshot), [close, snapshot], commandLine);
    appendFileSync(transcript, JSON.stringify({ type: 'TOOL_RESULT', content: text }) + '\n');
  }
  appendFileSync(transcript, JSON.stringify({ text: corpus[0][1] }) + '\n');
  appendFileSync(transcript, JSON.stringify({ text: 'Task id \\"active\\" failed' }) + '\n');
  appendFileSync(transcript, JSON.stringify({ text: 'Task id "poll-sentinel" finished with result: done' }) + '\n');
  const deadline = Date.now() + 2000;
  while (!settled.some(delta => delta.item.familyId === 'poll-sentinel') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(settled.map(delta => [delta.kind, delta.item.familyId]), [['item.close', 'poll-sentinel']]);
  assert.deepEqual(tr.getActiveTasks('t').map(task => task.taskId).sort(), ['active', 'native']);
});
