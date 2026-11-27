import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('ACP bridge delivers opt-in approval, blocks phantom tasks, and tracks Case 2 orphans', async t => {
  const run = promisify(execFile);
  const fixturePath = fileURLToPath(new URL('./bridge-fixture.mjs', import.meta.url));
  // Fail-fast guard must reject missing BB_ANTIGRAVITY_TASK_STATE_DIR before host.ts touches $HOME/.bb/plugin-data.
  const fakeHome = mkdtempSync(join(tmpdir(), 'auto-approve-home-'));
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));
  const envWithoutState = { ...process.env, HOME: fakeHome };
  delete envWithoutState.BB_ANTIGRAVITY_TASK_STATE_DIR;
  await assert.rejects(
    run(process.execPath, ['--experimental-strip-types', fixturePath, 'true'], { timeout: 30_000, env: envWithoutState }),
    /requires BB_ANTIGRAVITY_TASK_STATE_DIR/,
  );
  assert.equal(existsSync(join(fakeHome, '.bb', 'plugin-data')), false, 'fail-fast guard must not touch $HOME/.bb/plugin-data');

  // Give each run its own isolated state directory so run 2 cannot mask an orphan left behind by run 1.
  for (const enabled of ['true', 'false']) {
    const stateDir = mkdtempSync(join(tmpdir(), `auto-approve-state-${enabled}-`));
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const result = await run(process.execPath, ['--experimental-strip-types', fixturePath, enabled], { timeout: 30_000, env: { ...process.env, BB_ANTIGRAVITY_TASK_STATE_DIR: stateDir } });
    assert.match(result.stdout, /verified/, result.stderr);
    const persisted = JSON.parse(readFileSync(join(stateDir, 'background-tasks.json'), 'utf8'));
    assert.ok(!persisted.tasks.some(task => task.taskId === 'fake/phantom-1'), 'phantom task must never be persisted');
    assert.ok(!persisted.tasks.some(task => task.taskId === 'orphan-call-1'), 'settled orphan task must be removed from disk');
  }
});
