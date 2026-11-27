import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import {
  AGY_ACP_PROXY_FLAG,
  AGY_ACP_PROXY_STATE_DIR_ENV,
  AgyAcpProxy,
  advertiseFork,
  createInstructionStore,
  describeOutdatedAgy,
  extractSystemInstructions,
  isAgyVersionTooOld,
  parseAgyVersion,
  withSystemPrompt,
} from '../acp-proxy.ts';
import { resolveAntigravityLaunchSpec } from '../cli.ts';

const BLOCK = '<system_instructions>\nUse bb rules.\n</system_instructions>';
const line = message => JSON.stringify({ jsonrpc: '2.0', ...message });

function harness(store = createInstructionStore(undefined)) {
  const toAgent = [];
  const toClient = [];
  const logs = [];
  const proxy = new AgyAcpProxy({ toAgent: l => toAgent.push(JSON.parse(l)), toClient: l => toClient.push(JSON.parse(l)), store, log: m => logs.push(m) });
  return { proxy, toAgent, toClient, logs, store };
}

function openSession(h, mcpServers = [{ name: 'bb-bridge', command: 'node', args: [], env: [] }]) {
  h.proxy.fromClient(line({ id: 1, method: 'session/new', params: { cwd: '/work', mcpServers } }));
  h.proxy.fromAgent(line({ id: 1, result: { sessionId: 's1' } }));
  h.toAgent.length = 0;
  h.toClient.length = 0;
}

test('extracts only a well-formed bridge instructions block', () => {
  assert.equal(extractSystemInstructions(BLOCK), 'Use bb rules.');
  assert.equal(extractSystemInstructions(`${BLOCK}\n`), 'Use bb rules.');
  assert.equal(extractSystemInstructions('<system_instructions>\nunterminated'), undefined);
  assert.equal(extractSystemInstructions('hello <system_instructions>x</system_instructions>'), undefined);
  assert.equal(extractSystemInstructions('<system_instructions>\n  \n</system_instructions>'), undefined);
  assert.equal(extractSystemInstructions(42), undefined);
});

test('adds a system prompt to _meta without replacing one the client set', () => {
  assert.deepEqual(withSystemPrompt(undefined, 'a'), { antigravity: { systemPrompt: { append: 'a' } } });
  assert.deepEqual(withSystemPrompt({ other: 1, antigravity: { tier: true } }, 'a'), { other: 1, antigravity: { tier: true, systemPrompt: { append: 'a' } } });
  const own = { antigravity: { systemPrompt: { append: 'mine' } } };
  assert.equal(withSystemPrompt(own, 'a'), own);
});

test('passes unrelated traffic through unchanged, including non-JSON lines', () => {
  const sent = [];
  const proxy = new AgyAcpProxy({ toAgent: l => sent.push(l), toClient: l => sent.push(l), store: createInstructionStore(undefined) });
  const raw = '{"jsonrpc":"2.0","id":7,"method":"session/set_mode","params":{"sessionId":"s1","modeId":"plan"}}';
  proxy.fromClient(raw);
  proxy.fromClient('not json');
  proxy.fromAgent('{"jsonrpc":"2.0","method":"session/update","params":{}}');
  assert.deepEqual(sent, [raw, 'not json', '{"jsonrpc":"2.0","method":"session/update","params":{}}']);
});

test('moves the first-prompt instructions block into a live session/resume system prompt', () => {
  const h = harness();
  openSession(h);
  h.proxy.fromClient(line({ id: 2, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: BLOCK }, { type: 'text', text: '/plan do it' }] } }));
  assert.equal(h.toAgent.length, 1);
  const resume = h.toAgent[0];
  assert.equal(resume.method, 'session/resume');
  assert.match(resume.id, /^bb-agy-acp-proxy:/);
  assert.deepEqual(resume.params, {
    sessionId: 's1',
    cwd: '/work',
    mcpServers: [{ name: 'bb-bridge', command: 'node', args: [], env: [] }],
    _meta: { antigravity: { systemPrompt: { append: 'Use bb rules.' } } },
  });
  h.proxy.fromClient(line({ method: 'session/cancel', params: { sessionId: 's1' } }));
  assert.equal(h.toAgent.length, 1, 'later client messages wait for the resume');
  h.proxy.fromAgent(line({ id: resume.id, result: { configOptions: [] } }));
  assert.deepEqual(h.toClient, [], 'the proxy-originated response stays in the proxy');
  assert.deepEqual(h.toAgent.slice(1), [
    { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: '/plan do it' }] } },
    { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } },
  ]);
  assert.equal(h.store.get('s1'), 'Use bb rules.');
});

test('falls back to the original prompt when agy rejects the resume', () => {
  const h = harness();
  openSession(h);
  const prompt = { id: 2, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: BLOCK }, { type: 'text', text: 'hi' }] } };
  h.proxy.fromClient(line(prompt));
  h.proxy.fromAgent(line({ id: h.toAgent[0].id, error: { code: -32601, message: 'no' } }));
  assert.deepEqual(h.toAgent[1], { jsonrpc: '2.0', ...prompt });
  assert.equal(h.logs.length, 1);
});

test('leaves prompts alone when there is no block, no other input, or no known session', () => {
  const h = harness();
  openSession(h);
  const prompts = [
    { id: 2, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] } },
    { id: 3, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: BLOCK }] } },
    { id: 4, method: 'session/prompt', params: { sessionId: 'unknown', prompt: [{ type: 'text', text: BLOCK }, { type: 'text', text: 'hi' }] } },
  ];
  for (const p of prompts) h.proxy.fromClient(line(p));
  assert.deepEqual(h.toAgent, prompts.map(p => ({ jsonrpc: '2.0', ...p })));
});

test('re-applies stored instructions when the bridge loads or resumes the session', () => {
  const h = harness();
  h.store.set('s1', 'Use bb rules.');
  h.proxy.fromClient(line({ id: 5, method: 'session/load', params: { sessionId: 's1', cwd: '/work', mcpServers: [] } }));
  h.proxy.fromClient(line({ id: 6, method: 'session/resume', params: { sessionId: 's1', cwd: '/work', mcpServers: [], _meta: { antigravity: { systemPrompt: { append: 'mine' } } } } }));
  h.proxy.fromClient(line({ id: 7, method: 'session/load', params: { sessionId: 'other', cwd: '/work', mcpServers: [] } }));
  assert.deepEqual(h.toAgent[0].params._meta, { antigravity: { systemPrompt: { append: 'Use bb rules.' } } });
  assert.deepEqual(h.toAgent[1].params._meta, { antigravity: { systemPrompt: { append: 'mine' } } });
  assert.equal(h.toAgent[2].params._meta, undefined);
});

test('persists instructions per session and refuses unsafe session ids as file names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-proxy-store-'));
  try {
    createInstructionStore(dir).set('abc-123', 'rules');
    createInstructionStore(dir).set('../escape', 'nope');
    assert.equal(createInstructionStore(dir).get('abc-123'), 'rules');
    assert.equal(createInstructionStore(dir).get('../escape'), undefined);
    assert.deepEqual(readdirSync(dir), ['abc-123.json']);

    mkdirSync(join(dir, 'failed-rename.json'));
    const store = createInstructionStore(dir);
    store.set('failed-rename', 'in memory');
    assert.equal(store.get('failed-rename'), 'in memory');
    assert.deepEqual(readdirSync(dir).sort(), ['abc-123.json', 'failed-rename.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session launches go through the proxy; provider requests and BB_AGY_ACP_PROXY=0 do not', () => {
  const proxy = { hostFile: '/plugin/host.mjs', stateDir: '/data/acp-proxy/instructions' };
  const spec = () => ({ displayName: 'Antigravity CLI', command: 'agy', args: ['acp', '--disable-telemetry'], env: {} });
  const start = { method: 'thread/start', params: { options: { providerOptions: { acpLaunchSpec: spec() } } } };
  resolveAntigravityLaunchSpec(start, proxy);
  const launched = start.params.options.providerOptions.acpLaunchSpec;
  assert.equal(launched.command, process.execPath);
  assert.deepEqual(launched.args.slice(0, 2), ['/plugin/host.mjs', AGY_ACP_PROXY_FLAG]);
  assert.match(launched.args[2], /agy(\.exe)?$/);
  assert.deepEqual(launched.args.slice(3), ['acp', '--disable-telemetry']);
  assert.equal(launched.env[AGY_ACP_PROXY_STATE_DIR_ENV], proxy.stateDir);
  resolveAntigravityLaunchSpec(start, proxy);
  assert.equal(launched.args.length, 5, 'rewriting twice is a no-op');

  for (const request of [
    { method: 'provider/usage', params: { providerOptions: { acpLaunchSpec: spec() } } },
    { method: 'thread/start', params: { options: { envVars: { BB_AGY_ACP_PROXY: '0' }, providerOptions: { acpLaunchSpec: spec() } } } },
    { method: 'thread/start', params: { options: { providerOptions: { acpLaunchSpec: { ...spec(), env: { BB_AGY_ACP_PROXY: '0' } } } } } },
  ]) {
    resolveAntigravityLaunchSpec(request, proxy);
    const options = request.params.providerOptions ?? request.params.options.providerOptions;
    assert.notEqual(options.acpLaunchSpec.command, process.execPath);
    assert.deepEqual(options.acpLaunchSpec.args, ['acp', '--disable-telemetry']);
  }
});

test('the host module runs as the proxy process in front of the agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-proxy-run-'));
  const record = join(dir, 'received.jsonl');
  const host = fileURLToPath(new URL('../host.ts', import.meta.url));
  const agent = fileURLToPath(new URL('./fake-acp-recorder.mjs', import.meta.url));
  const child = spawn(process.execPath, [host, AGY_ACP_PROXY_FLAG, process.execPath, agent], {
    env: { ...process.env, RECORD_FILE: record, ELECTRON_RUN_AS_NODE: '1', [AGY_ACP_PROXY_STATE_DIR_ENV]: join(dir, 'state') },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const replies = new Map();
    createInterface({ input: child.stdout }).on('line', l => { const m = JSON.parse(l); replies.get(m.id)?.(m); });
    const call = (id, method, params) => new Promise(resolve => { replies.set(id, resolve); child.stdin.write(line({ id, method, params }) + '\n'); });
    const initialized = await call(1, 'initialize', { protocolVersion: 1 });
    assert.equal(initialized.result._meta.electronRunAsNode, null);
    await call(2, 'session/new', { cwd: dir, mcpServers: [] });
    const result = await call(3, 'session/prompt', { sessionId: 'rec-session', prompt: [{ type: 'text', text: BLOCK }, { type: 'text', text: 'hi' }] });
    assert.equal(result.result.stopReason, 'end_turn');
    const received = readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(received.map(m => m.method), ['initialize', 'session/new', 'session/resume', 'session/prompt']);
    assert.deepEqual(received[2].params._meta, { antigravity: { systemPrompt: { append: 'Use bb rules.' } } });
    assert.deepEqual(received[3].params.prompt, [{ type: 'text', text: 'hi' }]);
    assert.deepEqual(readdirSync(join(dir, 'state')), ['rec-session.json']);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recognizes an agy CLI too old for acp', () => {
  assert.deepEqual(parseAgyVersion('1.5.14\n'), [1, 5, 14]);
  assert.deepEqual(parseAgyVersion('agy version 1.1.24 (abc)'), [1, 1, 24]);
  assert.equal(parseAgyVersion('dev build'), undefined);
  assert.equal(isAgyVersionTooOld([1, 1, 24]), true);
  assert.equal(isAgyVersionTooOld([1, 4, 99]), true);
  assert.equal(isAgyVersionTooOld([1, 5, 0]), false);
  assert.equal(isAgyVersionTooOld([2, 0, 0]), false);
  assert.match(describeOutdatedAgy('/bin/agy', () => '1.1.24'), /Antigravity CLI 1\.1\.24 \(\/bin\/agy\) is too old for bb: `agy acp` needs 1\.5\.0 or later\. Run `agy update`/);
  assert.equal(describeOutdatedAgy('/bin/agy', () => '1.5.14'), undefined);
  assert.equal(describeOutdatedAgy('/bin/agy', () => { throw new Error('ENOENT'); }), undefined);
});

test('the proxy explains an outdated agy before its own error', { skip: process.platform === 'win32' }, async () => {
  const agent = fileURLToPath(new URL('./fake-old-agy.mjs', import.meta.url));
  chmodSync(agent, 0o755);
  const host = fileURLToPath(new URL('../host.ts', import.meta.url));
  const child = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning', host, AGY_ACP_PROXY_FLAG, agent, 'acp',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 2);
  const lines = stderr.trim().split('\n');
  assert.match(lines[0], /Antigravity CLI 1\.1\.24 .* is too old for bb/);
  assert.equal(lines[1], 'Error: unexpected argument "acp".');
});

test('advertises session/fork only when the proxy can fork', () => {
  const init = { id: 1, method: 'initialize', params: { protocolVersion: 1 } };
  const result = { id: 1, result: { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } } } };
  const withFork = harness();
  withFork.proxy = new AgyAcpProxy({ toAgent: l => withFork.toAgent.push(JSON.parse(l)), toClient: l => withFork.toClient.push(JSON.parse(l)), store: withFork.store, fork: () => 'x' });
  withFork.proxy.fromClient(line(init));
  withFork.proxy.fromAgent(line(result));
  assert.deepEqual(withFork.toClient[0].result.agentCapabilities.sessionCapabilities, { resume: {}, close: {}, fork: {} });
  assert.equal(withFork.toClient[0].result.agentCapabilities.loadSession, true);
  const without = harness();
  without.proxy.fromClient(line(init));
  without.proxy.fromAgent(line(result));
  assert.equal(without.toClient[0].result.agentCapabilities.sessionCapabilities.fork, undefined);
  assert.deepEqual(advertiseFork({ id: 2, result: {} }).result.agentCapabilities.sessionCapabilities, { fork: {} });
});

function forkHarness(fork) {
  const h = harness();
  h.proxy = new AgyAcpProxy({ toAgent: l => h.toAgent.push(JSON.parse(l)), toClient: l => h.toClient.push(JSON.parse(l)), store: h.store, fork, log: m => h.logs.push(m) });
  return h;
}

test('forks by copying the conversation and resuming the copy with the source instructions', () => {
  const forked = [];
  const h = forkHarness(source => { forked.push(source); return 'copy-1'; });
  h.store.set('src', 'Use bb rules.');
  const mcp = [{ name: 'bb-bridge', command: 'node', args: [], env: [] }];
  h.proxy.fromClient(line({ id: 9, method: 'session/fork', params: { sessionId: 'src', cwd: '/work', mcpServers: mcp, additionalDirectories: ['/extra'] } }));
  assert.deepEqual(forked, ['src']);
  assert.equal(h.store.get('copy-1'), 'Use bb rules.');
  const resume = h.toAgent[0];
  assert.equal(resume.method, 'session/resume');
  assert.deepEqual(resume.params, { sessionId: 'copy-1', cwd: '/work', mcpServers: mcp, additionalDirectories: ['/extra'], _meta: { antigravity: { systemPrompt: { append: 'Use bb rules.' } } } });
  h.proxy.fromAgent(line({ id: resume.id, result: { configOptions: [{ id: 'model' }], sessionId: 'ignored' } }));
  assert.deepEqual(h.toClient, [{ jsonrpc: '2.0', id: 9, result: { configOptions: [{ id: 'model' }], sessionId: 'copy-1' } }]);
});

test('reports fork failures to bb as errors', () => {
  const copyFails = forkHarness(() => { throw new Error('disk full'); });
  copyFails.proxy.fromClient(line({ id: 9, method: 'session/fork', params: { sessionId: 'src', cwd: '/work', mcpServers: [] } }));
  assert.equal(copyFails.toAgent.length, 0);
  assert.match(copyFails.toClient[0].error.message, /Could not fork the Antigravity conversation: disk full/);

  const openFails = forkHarness(() => 'copy-1');
  openFails.proxy.fromClient(line({ id: 9, method: 'session/fork', params: { sessionId: 'src', cwd: '/work', mcpServers: [] } }));
  assert.equal(openFails.toAgent[0].params._meta, undefined, 'no instructions stored for the source');
  openFails.proxy.fromAgent(line({ id: openFails.toAgent[0].id, error: { code: -32000, message: 'nope' } }));
  assert.match(openFails.toClient[0].error.message, /could not open it: nope/);

  const noFork = harness();
  noFork.proxy.fromClient(line({ id: 9, method: 'session/fork', params: { sessionId: 'src' } }));
  assert.equal(noFork.toAgent[0].method, 'session/fork', 'without a forker the request reaches agy unchanged');
});

test('with BB_AGY_ACP_PROXY=0 a started proxy relays lines unchanged and offers no fork', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-proxy-off-'));
  const record = join(dir, 'received.jsonl');
  const host = fileURLToPath(new URL('../host.ts', import.meta.url));
  const agent = fileURLToPath(new URL('./fake-acp-recorder.mjs', import.meta.url));
  const child = spawn(process.execPath, [host, AGY_ACP_PROXY_FLAG, process.execPath, agent], {
    env: { ...process.env, RECORD_FILE: record, BB_AGY_ACP_PROXY: '0' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const replies = new Map();
    createInterface({ input: child.stdout }).on('line', l => { const m = JSON.parse(l); replies.get(m.id)?.(m); });
    const call = (id, method, params) => new Promise(resolve => { replies.set(id, resolve); child.stdin.write(line({ id, method, params }) + '\n'); });
    const init = await call(1, 'initialize', { protocolVersion: 1 });
    assert.equal(init.result.agentCapabilities.sessionCapabilities, undefined);
    await call(2, 'session/new', { cwd: dir, mcpServers: [] });
    const prompt = [{ type: 'text', text: BLOCK }, { type: 'text', text: 'hi' }];
    await call(3, 'session/prompt', { sessionId: 'rec-session', prompt });
    const received = readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(received.map(m => m.method), ['initialize', 'session/new', 'session/prompt']);
    assert.deepEqual(received[2].params.prompt, prompt);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reports a chat reply to /compact as a failed compaction, and leaves real compactions alone', () => {
  const chunk = (sessionId, text) => line({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  const compact = id => line({ id, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: '/compact' }] } });

  const failed = harness();
  failed.proxy.fromClient(compact(4));
  failed.proxy.fromAgent(chunk('s1', 'There is nothing to compact yet.'));
  failed.proxy.fromAgent(chunk('other', 'unrelated'));
  failed.proxy.fromAgent(line({ id: 4, result: { stopReason: 'end_turn' } }));
  const methods = failed.toClient.map(m => m.method ?? `response:${m.id}`);
  assert.deepEqual(methods, ['session/update', 'session/update', 'session/update', 'response:4'], 'the failure precedes the response');
  const update = failed.toClient[2].params.update;
  assert.equal(failed.toClient[2].params.sessionId, 's1');
  assert.equal(update.sessionUpdate, 'compaction_update');
  assert.equal(update.status, 'failed');
  assert.match(update.compactionId, /^bb-agy-acp-proxy:compact-/);
  assert.equal(update.error, 'Antigravity did not compact the conversation: There is nothing to compact yet.');

  const real = harness();
  real.proxy.fromClient(compact(5));
  real.proxy.fromAgent(line({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 10, size: 100 } } }));
  real.proxy.fromAgent(line({ id: 5, result: { stopReason: 'end_turn' } }));
  assert.equal(real.toClient.some(m => m.params?.update?.sessionUpdate === 'compaction_update'), false);

  const cancelled = harness();
  cancelled.proxy.fromClient(compact(6));
  cancelled.proxy.fromAgent(chunk('s1', 'partial'));
  cancelled.proxy.fromAgent(line({ id: 6, result: { stopReason: 'cancelled' } }));
  assert.equal(cancelled.toClient.some(m => m.params?.update?.sessionUpdate === 'compaction_update'), false, 'bb already treats cancelled as interrupted');

  const toolOnly = harness();
  toolOnly.proxy.fromClient(compact(8));
  toolOnly.proxy.fromAgent(line({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } } } }));
  toolOnly.proxy.fromAgent(line({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'ls' } } }));
  toolOnly.proxy.fromAgent(line({ id: 8, result: { stopReason: 'end_turn' } }));
  const toolOnlyUpdate = toolOnly.toClient.find(m => m.params?.update?.sessionUpdate === 'compaction_update');
  assert.match(toolOnlyUpdate.params.update.error, /passed \/compact to the model/);

  const ordinary = harness();
  ordinary.proxy.fromClient(line({ id: 7, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'compact this file please' }] } }));
  ordinary.proxy.fromAgent(chunk('s1', 'Sure.'));
  ordinary.proxy.fromAgent(line({ id: 7, result: { stopReason: 'end_turn' } }));
  assert.equal(ordinary.toClient.some(m => m.params?.update?.sessionUpdate === 'compaction_update'), false);
});

test('prunes only old instructions for deleted conversations in the current profile', async () => {
  const { pruneInstructionStore } = await import('../acp-proxy.ts');
  const { mkdirSync, utimesSync, writeFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'agy-proxy-prune-'));
  const store = join(root, 'store');
  const profileA = join(root, 'profile-a');
  const profileB = join(root, 'profile-b');
  const conversations = join(profileA, 'conversations');
  mkdirSync(store);
  mkdirSync(conversations, { recursive: true });
  try {
    const old = Date.now() / 1000 - 3 * 24 * 3600;
    for (const id of ['gone-old', 'kept-old', 'gone-new']) createInstructionStore(store, profileA).set(id, 'rules');
    createInstructionStore(store, profileB).set('other-profile', 'rules B');
    writeFileSync(join(store, 'legacy.json'), JSON.stringify({ version: 1, instructions: 'old rules' }));
    writeFileSync(join(store, 'notes.txt'), 'x');
    utimesSync(join(store, 'gone-old.json'), old, old);
    utimesSync(join(store, 'kept-old.json'), old, old);
    utimesSync(join(store, 'legacy.json'), old, old);
    utimesSync(join(store, 'other-profile.json'), old, old);
    writeFileSync(join(conversations, 'kept-old.db'), '');
    assert.deepEqual(pruneInstructionStore(store, profileA), ['gone-old']);
    assert.deepEqual(readdirSync(store).sort(), ['gone-new.json', 'kept-old.json', 'legacy.json', 'notes.txt', 'other-profile.json']);
    assert.deepEqual(pruneInstructionStore(store, profileB), ['other-profile']);
    assert.equal(createInstructionStore(store).get('legacy'), 'old rules');
    assert.deepEqual(pruneInstructionStore(join(root, 'missing'), profileA), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('passes session/fork through natively when agy itself advertises fork support', () => {
  let proxyForkCalls = 0;
  const h = harness({ fork: () => { proxyForkCalls++; return 'proxy-copy'; } });
  h.proxy.fromClient(line({ id: 1, method: 'initialize', params: { protocolVersion: 1 } }));
  h.proxy.fromAgent(line({ id: 1, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { fork: { native: true } } } } }));
  assert.deepEqual(h.toClient[0].result.agentCapabilities.sessionCapabilities.fork, { native: true });

  h.proxy.fromClient(line({ id: 2, method: 'session/fork', params: { sessionId: 's1', cwd: '/work', mcpServers: [] } }));
  assert.equal(proxyForkCalls, 0);
  assert.equal(h.toAgent.at(-1).method, 'session/fork');
  assert.equal(h.toAgent.at(-1).id, 2);
});

test('translates agy executor-busy prompt error into retryable BB session_busy error', () => {
  const h = harness();
  h.proxy.fromClient(line({ id: 10, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'follow-up' }] } }));
  h.proxy.fromAgent(line({
    id: 10,
    error: {
      code: -32603,
      message: 'Failed to send user message: executor has not processed the previous input yet',
      data: { details: 'executor busy' },
    },
  }));
  assert.equal(h.toClient.length, 1);
  assert.equal(h.toClient[0].error.code, -32003);
  assert.equal(h.toClient[0].error.data.reason, 'session_busy');
  assert.equal(h.toClient[0].error.data.details, 'executor busy');
  assert.match(h.toClient[0].error.message, /executor has not processed the previous input yet/);

  // Unrelated prompt errors and non-prompt errors pass through unchanged.
  h.proxy.fromClient(line({ id: 11, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'bad' }] } }));
  h.proxy.fromAgent(line({ id: 11, error: { code: -32602, message: 'Invalid prompt' } }));
  assert.equal(h.toClient[1].error.code, -32602);
  assert.equal(h.toClient[1].error.data, undefined);

  h.proxy.fromClient(line({ id: 12, method: 'session/resume', params: { sessionId: 's1' } }));
  h.proxy.fromAgent(line({ id: 12, error: { code: -32603, message: 'executor has not processed the previous input yet' } }));
  assert.equal(h.toClient[2].error.code, -32603);
});

test('preserves text and object details on retryable busy errors', () => {
  const message = 'executor has not processed the previous input yet';
  const h = harness();
  for (const [data, expected] of [
    ['original detail', { details: 'original detail', reason: 'session_busy' }],
    [{ origin: 'agy' }, { origin: 'agy', details: message, reason: 'session_busy' }],
    [undefined, { details: message, reason: 'session_busy' }],
  ]) {
    h.proxy.fromClient(line({ id: 1, method: 'session/prompt', params: { sessionId: 's1' } }));
    h.proxy.fromAgent(line({ id: 1, error: { code: -32603, message, data } }));
    assert.deepEqual(h.toClient.at(-1).error.data, expected);
  }
});
