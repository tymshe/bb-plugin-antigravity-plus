import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const hostFixture = fileURLToPath(new URL('./host-bridge-fixture.mjs', import.meta.url));
const agentFixture = fileURLToPath(new URL('./fake-acp-recorder.mjs', import.meta.url));

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'agy-profile-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const spawns = join(root, 'spawns');
  writeFileSync(spawns, '');
  const agy = join(root, 'agy');
  // The host resolves the real executable from PATH. The fixture records launches before reading ACP input.
  writeFileSync(agy, `#!/bin/sh\nexec "${process.execPath}" "${agentFixture}" "$@"\n`, { mode: 0o755 });
  const stateDir = join(root, 'state');
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: root + delimiter + process.env.PATH,
    BB_ANTIGRAVITY_TASK_STATE_DIR: stateDir, AGY_TEST_SPAWNS: spawns,
  };
  delete env.BB_ANTIGRAVITY_GEMINI_DIR;
  delete env.BB_ANTIGRAVITY_APP_DATA_DIR;
  delete env.BB_AGY_ACP_PROXY;
  return { root, env, stateDir, launches: () => readFileSync(spawns, 'utf8').trim().split('\n').filter(Boolean) };
}

async function withHost(env, run) {
  const child = spawn(process.execPath, ['--experimental-strip-types', hostFixture], {
    env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  const messages = [];
  let stderr = '';
  let id = 0;
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => messages.push(JSON.parse(line)));
  async function waitFor(predicate) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && child.exitCode === null) {
      const message = messages.find(predicate);
      if (message) return message;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`Bridge did not respond. Stderr: ${stderr}\nMessages: ${JSON.stringify(messages)}`);
  }
  async function call(method, params) {
    const requestId = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, id: requestId, params }) + '\n');
    return waitFor(message => message.id === requestId && !message.method);
  }
  try {
    assert.ok((await call('initialize', { protocolVersion: 1, client: { name: 'test', version: '1' } })).result);
    await run({ call, messages, waitFor });
  } finally {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 3000);
    await closed;
    clearTimeout(timeout);
  }
}

function sessionParams(cwd, threadId = 'thread') {
  return {
    threadId, cwd, instructionMode: 'append',
    options: {
      permissionMode: 'accept-edits', permissionScope: 'workspace',
      approvalReviewer: 'user', permissionEscalation: 'ask',
      providerOptions: { acpLaunchSpec: { displayName: 'Fake agy', command: 'agy', args: ['acp'] } },
    },
  };
}

test('the host rejects profile drift across restarts before opening agy', { skip: process.platform === 'win32' }, async t => {
  const { root, env, stateDir, launches } = setup(t);
  const profileA = { ...env, BB_ANTIGRAVITY_GEMINI_DIR: join(root, 'profile-a') };
  const params = sessionParams(root);
  let providerThreadId;
  await withHost(profileA, async ({ call }) => {
    const started = await call('thread/start', params);
    providerThreadId = started.result?.providerThreadId;
    assert.ok(providerThreadId, JSON.stringify(started));
    assert.equal((await call('thread/stop', {
      threadId: params.threadId, providerThreadId, intent: 'release', activeTurnId: null,
    })).result?.ok, true);
  });
  const resume = { ...params, providerThreadId };
  for (const drifted of [
    env,
    { ...env, BB_ANTIGRAVITY_GEMINI_DIR: join(root, 'profile-b') },
    { ...profileA, BB_ANTIGRAVITY_APP_DATA_DIR: 'other-app-data' },
  ]) {
    await withHost(drifted, async ({ call }) => {
      const before = launches();
      assert.match((await call('thread/resume', resume)).error?.message ?? '', /profile.*(changed|match)/i);
      const fork = { ...sessionParams(root, 'fork'), sourceProviderThreadId: providerThreadId };
      assert.match((await call('thread/fork', fork)).error?.message ?? '', /profile.*(changed|match)/i);
      const turn = { ...resume, clientRequestId: 'creq_23456789ab', input: [{ type: 'text', text: 'hello' }] };
      assert.match((await call('turn/start', turn)).error?.message ?? '', /profile.*(changed|match)/i);
      assert.deepEqual(launches(), before);
    });
  }
  await withHost({ ...profileA, BB_ANTIGRAVITY_GEMINI_DIR: profileA.BB_ANTIGRAVITY_GEMINI_DIR + '/.' }, async ({ call }) => {
    assert.equal((await call('thread/resume', resume)).result?.providerThreadId, providerThreadId);
    assert.equal((await call('thread/discard', resume)).result?.ok, true);
  });
  assert.deepEqual(launches(), Array(2).fill(join(root, 'profile-a', 'antigravity-cli')));
  const persisted = readFileSync(join(stateDir, 'profile-bindings.json'), 'utf8');
  assert.equal(persisted.includes(providerThreadId), false);
  await withHost(env, async ({ call }) => {
    assert.equal((await call('thread/resume', resume)).result?.providerThreadId, providerThreadId);
  });
});

test('independent hosts preserve each other’s profile bindings when opening sessions concurrently', { skip: process.platform === 'win32' }, async t => {
  const { root, env, stateDir } = setup(t);
  const threads = ['one', 'two', 'three'];
  await Promise.all(threads.map(threadId => withHost(env, async ({ call }) => {
    const started = await call('thread/start', sessionParams(root, threadId));
    assert.ok(started.result?.providerThreadId, JSON.stringify(started));
  })));
  const { bindings } = JSON.parse(readFileSync(join(stateDir, 'profile-bindings.json'), 'utf8'));
  assert.deepEqual(bindings.map(binding => binding.threadId).sort(), [...threads].sort());
});

test('default profile survives a host restart, including explicitly empty overrides', { skip: process.platform === 'win32' }, async t => {
  const { root, env, launches } = setup(t);
  const params = sessionParams(root);
  let providerThreadId;
  await withHost(env, async ({ call }) => {
    providerThreadId = (await call('thread/start', params)).result?.providerThreadId;
    assert.ok(providerThreadId);
  });
  await withHost({ ...env, BB_ANTIGRAVITY_GEMINI_DIR: '', BB_ANTIGRAVITY_APP_DATA_DIR: '' }, async ({ call }) => {
    assert.equal((await call('thread/resume', { ...params, providerThreadId })).result?.providerThreadId, providerThreadId);
  });
  assert.deepEqual(launches(), Array(2).fill(join(env.HOME, '.gemini', 'antigravity-cli')));
});

test('importing the host and read-only bridge traffic leave default state absent', async t => {
  const { env } = setup(t);
  delete env.BB_ANTIGRAVITY_TASK_STATE_DIR;
  execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    'await import("./host.ts")'], { env });
  await withHost(env, async ({ call }) => {
    const discard = await call('thread/discard', { threadId: 'unknown', providerThreadId: 'unknown' });
    assert.equal(discard.result?.ok, true);
  });
  assert.equal(existsSync(join(env.HOME, '.bb', 'plugin-data')), false);
});

test('real bridge verifies standalone compact on end_turn and still surfaces later automatic checkpoints', { skip: process.platform === 'win32' }, async t => {
  const { root, env } = setup(t);
  const params = sessionParams(root);
  await withHost(env, async ({ call, messages, waitFor }) => {
    const { result } = await call('thread/start', params);
    assert.ok(result?.providerThreadId);
    async function turn(text, clientRequestId) {
      const from = messages.length;
      const mentions = text === '/compact' ? [{
        start: 0, end: text.length,
        resource: { kind: 'command', trigger: '/', name: 'compact', source: 'command', origin: 'builtin',
          label: 'Compact', argumentHint: null },
      }] : [];
      assert.ok((await call('turn/start', {
        ...params, providerThreadId: result.providerThreadId, clientRequestId, input: [{ type: 'text', text, mentions }],
      })).result);
      await waitFor(message => messages.indexOf(message) >= from && message.params?.deltas?.some(delta => delta.kind === 'turn.boundary'));
      return messages.slice(from).flatMap(message => message.params?.deltas ?? []);
    }
    const compacted = await turn('/compact', 'creq_23456789ab');
    const cards = compacted.filter(delta => delta.item?.type === 'compaction');
    assert.deepEqual(cards.map(card => card.kind), ['item.open', 'item.close'], JSON.stringify(compacted));
    assert.equal(cards[1].key.channel, 'compaction', JSON.stringify(compacted));
    assert.equal(cards[1].status, 'completed');
    assert.equal(cards[1].presentation.detail, '50.0k -> 20.0k tokens');
    assert.equal(compacted.filter(delta => delta.kind === 'context.compacted').length, 1);

    const noop = await turn('/compact', 'creq_3456789abc');
    const noOpClose = noop.find(delta => delta.kind === 'item.close' && delta.item?.type === 'compaction');
    assert.equal(noOpClose?.status, 'failed');
    assert.match(noOpClose.presentation.detail, /checkpoint/i);
    assert.equal(noop.some(delta => delta.kind === 'context.compacted'), false);

    const automatic = await turn('auto-checkpoint', 'creq_456789abcd');
    assert.ok(automatic.some(delta => delta.kind === 'item.close' && delta.key?.providerItemId === 'agy-auto-compact:3'));
  });
});

test('the shared bridge retries an agy executor busy response and completes the turn', { skip: process.platform === 'win32' }, async t => {
  const { root, env } = setup(t);
  const record = join(root, 'received.jsonl');
  const params = sessionParams(root);
  await withHost({ ...env, AGY_TEST_BUSY_ONCE: '1', RECORD_FILE: record }, async ({ call, waitFor }) => {
    const { result } = await call('thread/start', params);
    assert.ok(result?.providerThreadId);
    assert.ok((await call('turn/start', {
      ...params, providerThreadId: result.providerThreadId, clientRequestId: 'creq_23456789ab',
      input: [{ type: 'text', text: 'retry this prompt' }],
    })).result);
    const ended = await waitFor(message => message.params?.deltas?.some(delta => delta.kind === 'turn.boundary'));
    assert.equal(ended.params.deltas.find(delta => delta.kind === 'turn.boundary').status, 'completed');
    const prompts = readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(message => message.method === 'session/prompt');
    assert.equal(prompts.length, 2);
    assert.deepEqual(prompts[1].params, prompts[0].params);
  });
});

test('the Swarm host handler reads the bound session profile after a legacy binding is resumed', { skip: process.platform === 'win32' }, async t => {
  const { root, env, stateDir } = setup(t);
  const appDataDir = join(root, 'bound-app-data');
  const params = sessionParams(root);
  params.options.envVars = { BB_ANTIGRAVITY_APP_DATA_DIR: appDataDir };
  let providerThreadId;
  await withHost(env, async ({ call }) => {
    providerThreadId = (await call('thread/start', params)).result?.providerThreadId;
    assert.ok(providerThreadId);
  });
  const path = join(stateDir, 'profile-bindings.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(state.bindings[0].appDataDir, appDataDir);
  delete state.bindings[0].appDataDir;
  writeFileSync(path, JSON.stringify(state));
  await withHost(env, async ({ call }) => {
    assert.equal((await call('thread/resume', { ...params, providerThreadId })).result?.providerThreadId, providerThreadId);
  });
  const swarm = join(appDataDir, 'brain', providerThreadId, '.system_generated', 'swarm');
  mkdirSync(swarm, { recursive: true });
  writeFileSync(join(swarm, 'members.json'), JSON.stringify({ title: 'Bound profile board', members: [] }));
  const snapshot = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    'const { default: host } = await import("./host.ts"); console.log(JSON.stringify(await host.handlers.readSwarmBoard({ providerThreadId: process.argv[1] })))',
    providerThreadId,
  ], { env: { ...env, BB_ANTIGRAVITY_APP_DATA_DIR: join(root, 'other-profile') }, encoding: 'utf8', timeout: 30_000 }));
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.title, 'Bound profile board');
});
