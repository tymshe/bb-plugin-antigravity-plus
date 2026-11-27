import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPromptMode } from '../prompt-mode.ts';

test('Plan and Build override stale native modes and preserve other options', () => {
  for (const permissionMode of ['accept-edits', 'full']) {
    for (const promptMode of ['plan', undefined]) {
      const line = JSON.stringify({ method: 'turn/start', params: { options: {
        permissionMode, promptMode, sessionOptions: { mode: 'default', other: 'keep' },
      } } });
      const options = JSON.parse(mapPromptMode(line)).params.options;
      assert.equal(options.sessionOptions.mode, promptMode === 'plan' ? 'plan' : 'accept-edits');
      assert.equal(options.sessionOptions.other, 'keep');
      assert.equal(options.permissionMode, permissionMode);
    }
  }
  for (const line of ['invalid', 'null', '{"method":"initialize"}']) assert.equal(mapPromptMode(line), line);
});

test('stored native modes do not override the /plan action or permissions', () => {
  for (const permissionMode of ['accept-edits', 'full']) {
    for (const mode of ['plan', 'accept-edits', 'default', 'auto', undefined]) {
      for (const promptMode of ['plan', undefined]) {
        const options = JSON.parse(mapPromptMode(JSON.stringify({method: 'turn/start', params: {options: {permissionMode, promptMode, sessionOptions: {mode}}}}))).params.options;
        assert.equal(options.sessionOptions.mode, promptMode === 'plan' ? 'plan' : 'accept-edits');
        assert.equal(options.permissionMode, permissionMode);
      }
    }
  }
});
