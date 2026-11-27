import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const hostFixture = fileURLToPath(import.meta.url);

if (process.argv[1] === hostFixture) {
  const { experimental_providerBridge: bridge } = await import('../host.ts');
  bridge.start();
  const input = createInterface({ input: process.stdin });
  input.on('line', line => bridge.handleLine(line));
  input.on('close', () => bridge.onClose());
}

export async function withHost(env, run) {
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
  function reply(id, result) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }
  async function call(method, params) {
    const requestId = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, id: requestId, params }) + '\n');
    return waitFor(message => message.id === requestId && !message.method);
  }
  try {
    assert.ok((await call('initialize', { protocolVersion: 1, client: { name: 'test', version: '1' } })).result);
    await run({ call, reply, messages, waitFor });
  } finally {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 3000);
    await closed;
    clearTimeout(timeout);
  }
}

export function setupFakeAgy(t, agentFixture) {
  const root = mkdtempSync(join(tmpdir(), 'agy-host-bridge-'));
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

export function sessionParams(cwd, threadId = 'thread') {
  return {
    threadId, cwd, instructionMode: 'append',
    options: {
      permissionMode: 'accept-edits', permissionScope: 'workspace',
      approvalReviewer: 'user', permissionEscalation: 'ask',
      providerOptions: { acpLaunchSpec: { displayName: 'Fake agy', command: 'agy', args: ['acp'] } },
    },
  };
}
