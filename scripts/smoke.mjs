import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { experimental_execHostFile } from '@get-bb/plugin-sdk/process';
import { providerUsageResultSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { parseAgyVersion } from '../acp-proxy.ts';
import { resolveAntigravityCommand } from '../cli.ts';
import { readAntigravityProviderUsage } from '../usage.ts';
import manifest from '../package.json' with { type: 'json' };

const command = resolveAntigravityCommand('agy');
if (!command) throw new Error('Antigravity CLI was not found on this host.');
const cwd = await mkdtemp(join(tmpdir(), 'bb-antigravity-smoke-'));
const child = spawn(command, ['acp', '--disable-telemetry'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
const closed = new Promise(resolve => child.once('close', resolve));
const pending = new Map();
let id = 0;
let response = '';
child.stderr.resume(); // Do not copy vendor diagnostics or account details into public output.
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  line = line.trim();
  if (!line.startsWith('{')) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'session/update') {
    const update = message.params?.update;
    if (update?.sessionUpdate === 'agent_message_chunk') response += update.content?.text ?? '';
  }
  if (message.method && message.id !== undefined) {
    // Fail closed: this smoke test never authorizes tools or filesystem access.
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not supported by smoke test' } }) + '\n');
  } else if (message.id !== undefined) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`ACP rejected ${request.method} (code ${Number(message.error.code)}).`));
    else request.resolve(message.result);
  }
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    pending.set(++id, { method, resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 60000);
child.on('error', () => { for (const p of pending.values()) p.reject(new Error('Could not launch agy')); });
child.on('exit', () => { for (const p of pending.values()) p.reject(new Error('ACP exited before completing')); });
try {
  if (process.argv.includes('--usage')) {
    const { stdout, stderr } = await experimental_execHostFile(command, ['--version'], { cwd, timeout: 10_000 });
    assert.ok(parseAgyVersion(stdout + '\n' + stderr), 'Could not parse agy --version.');
    const { usage } = providerUsageResultSchema.parse(await readAntigravityProviderUsage({ command, cwd }));
    assert.equal(usage?.status, 'ok', 'Usage probe did not return quota windows.');
    assert.ok(usage.windows.length > 0, 'Usage probe returned no quota windows.');
    console.log('CLI version and quota windows passed.');
    console.log('Quota windows in display order', JSON.stringify(usage.windows.map(window => window.label)));
  }
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'bb-antigravity-plus-smoke', version: manifest.version } });
  assert.equal(initialized.protocolVersion, 1);
  if (process.argv.includes('--capabilities')) console.log(JSON.stringify(initialized.agentCapabilities, null, 2));
  const session = await request('session/new', { cwd, mcpServers: [] });
  assert.ok(session.sessionId);
  if (process.argv.includes('--modes')) {
    const modes = session.modes?.availableModes ?? [];
    assert.ok(modes.some(mode => mode.id === 'plan'));
    assert.ok(modes.some(mode => mode.id === 'accept-edits'));
    for (const modeId of ['plan', 'accept-edits']) {
      await request('session/set_mode', { sessionId: session.sessionId, modeId });
    }
    console.log('Native Plan and Accept edits mode transitions passed.');
  }
  if (process.argv.includes('--features')) {
    const second = await request('session/new', { cwd, mcpServers: [] });
    assert.notEqual(session.sessionId, second.sessionId);
    await request('session/load', { sessionId: session.sessionId, cwd, mcpServers: [] });
    console.log('Independent sessions and session load passed.');
  }
  if (process.argv.includes('--prompt')) {
    const result = await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Reply with exactly ACP_OK. Do not use tools.' }] });
    assert.equal(result.stopReason, 'end_turn');
    assert.match(response, /ACP_OK/);
  }
  console.log('ACP initialization, session creation' + (process.argv.includes('--prompt') ? ', and prompt passed.' : ' passed.'));
} finally {
  clearTimeout(timeout);
  lines.close();
  child.kill();
  await closed;
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

