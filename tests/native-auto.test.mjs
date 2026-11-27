import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mapPromptMode } from '../prompt-mode.ts';

const auto = { permissionMode: 'auto', permissionScope: 'workspace', approvalReviewer: 'automatic', permissionEscalation: 'ask' };

test('BB Auto reaches the bridge as Accept edits with user review and native agy auto mode', () => {
  for (const method of ['thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'turn/steer']) {
    const options = JSON.parse(mapPromptMode(JSON.stringify({ method, params: { options: { ...auto, sessionOptions: { mode: 'accept-edits', other: 'keep' } } } }))).params.options;
    assert.equal(options.permissionMode, 'accept-edits', method);
    assert.equal(options.approvalReviewer, 'user', method);
    assert.equal(options.permissionScope, 'workspace', method);
    assert.equal(options.permissionEscalation, 'ask', method);
    assert.equal(options.sessionOptions.mode, 'auto', method);
    assert.equal(options.sessionOptions.other, 'keep', method);
  }
});

test('Plan wins over native auto and other permission modes are untouched', () => {
  for (const planned of [{ promptMode: 'plan' }, { sessionOptions: { mode: 'plan' } }]) {
    const options = JSON.parse(mapPromptMode(JSON.stringify({ method: 'turn/start', params: { options: { ...auto, ...planned } } }))).params.options;
    assert.equal(options.sessionOptions.mode, 'plan');
    assert.equal(options.permissionMode, 'accept-edits');
  }
  const full = JSON.stringify({ method: 'thread/start', params: { options: { permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null } } });
  assert.equal(mapPromptMode(full), full);
});

test('Auto runs through the real ACP bridge and switches agy to its native auto mode', async t => {
  const run = promisify(execFile);
  const fixture = fileURLToPath(new URL('./native-auto-fixture.mjs', import.meta.url));
  const stateDir = mkdtempSync(join(tmpdir(), 'native-auto-state-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const env = { ...process.env, BB_ANTIGRAVITY_TASK_STATE_DIR: stateDir, BB_AGY_ACP_PROXY: '0' };
  const mode = async (...args) => {
    const { stdout } = await run(process.execPath, ['--experimental-strip-types', fixture, ...args], { timeout: 15000, env });
    return stdout.match(/RESULT (\S+)/)?.[1] ?? stdout;
  };
  const warned = async (...args) => {
    const { stdout } = await run(process.execPath, ['--experimental-strip-types', fixture, ...args], { timeout: 15000, env });
    return stdout.match(/WARNED (\S+)/)?.[1];
  };
  assert.equal(await mode('auto', '-'), 'auto');
  assert.equal(await mode('auto', 'plan'), 'plan');
  assert.equal(await mode('accept-edits', '-'), 'accept-edits');
  // An account without native Auto keeps working in Accept edits instead of failing the turn.
  assert.equal(await mode('auto', '-', '--no-auto'), 'accept-edits');
  assert.equal(await warned('auto', '-', '--no-auto'), 'true');
  assert.equal(await warned('auto', '-'), 'false');
});
