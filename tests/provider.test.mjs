import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../server.ts';
import { experimental_acpLaunchSpecSchema } from '@get-bb/plugin-sdk/provider-bridge/acp';

test('registers a native ACP provider without changing credentials or bypassing approvals', async () => {
  const declarations = [];
  await plugin({
    settings: {
      define(descriptors) {
        assert.deepEqual(Object.keys(descriptors), [
          'autoOpenSwarmBoard',
          'commandDescriptionsEnabled',
          'subagentsDisabled',
          'acceptEditsApproval',
          'sandbox',
        ]);
        assert.equal(descriptors.autoOpenSwarmBoard.default, true);
        assert.equal(descriptors.commandDescriptionsEnabled.default, true);
        assert.equal(descriptors.subagentsDisabled.default, false);
        assert.equal(descriptors.acceptEditsApproval.type, 'select');
        assert.equal(descriptors.acceptEditsApproval.default, 'ask');
        assert.deepEqual(descriptors.acceptEditsApproval.options, ['ask', 'auto-in-sandbox', 'auto-all']);
        assert.equal(descriptors.sandbox.default, false);
        return { get: async () => ({}), onChange() {} };
      },
    },
    providers: { register(value) { declarations.push(value); return { dispose() {} }; } },
  });
  assert.equal(declarations.length, 1);
  const provider = declarations[0];
  assert.equal(provider.id, 'antigravity-plus');
  assert.equal(provider.displayName, 'Antigravity Provider +');
  assert.equal(provider.icon, './assets/provider.svg');
  assert.deepEqual(provider.composerActions, []);
  const spec = experimental_acpLaunchSpecSchema.parse(provider.experimental_bridgeOptions.acpLaunchSpec);
  assert.equal(spec.command, 'agy');
  assert.deepEqual(spec.args, ['acp', '--disable-telemetry']);
  assert.deepEqual(spec.env, {});
  assert.equal(spec.cwd, undefined);
  assert.equal(spec.permissionCli, undefined);
  assert.deepEqual(provider.capabilities.permissionModes, ['accept-edits', 'auto', 'full']);
  assert.deepEqual(provider.capabilities.reasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(provider.maintenance, { health: true, usage: true, installation: true });
  assert.equal(provider.experimental_bridgeOptions.acpDialect, 'antigravity-plus');
});

test('deriveProviderOptions always isolates sessions and maps approval and sandbox settings cleanly', async () => {
  let provider;
  await plugin({
    settings: { define() { return { get: async () => ({}), onChange() {} }; } },
    providers: { register(value) { provider = value; return { dispose() {} }; } },
  });
  for (const sandbox of [undefined, false, true, 'true']) {
    const options = provider.deriveProviderOptions({ settings: { sandbox } });
    const spec = experimental_acpLaunchSpecSchema.parse(options.acpLaunchSpec);
    assert.deepEqual(spec.args, [
      'acp',
      '--disable-telemetry',
      '--process-per-session',
      ...(sandbox === true ? ['--sandbox'] : []),
    ]);
    assert.equal(spec.command, 'agy');
    assert.deepEqual(spec.env, {});
    assert.equal(options.acpDialect, 'antigravity-plus');
  }

  // acceptEditsApproval select mapping
  const askDefault = provider.deriveProviderOptions({ settings: {} });
  assert.equal(askDefault.autoApprove, false);
  assert.equal(askDefault.promptOnSandboxEscape, true);

  const askExplicit = provider.deriveProviderOptions({ settings: { acceptEditsApproval: 'ask' } });
  assert.equal(askExplicit.autoApprove, false);
  assert.equal(askExplicit.promptOnSandboxEscape, true);

  const inSandbox = provider.deriveProviderOptions({ settings: { acceptEditsApproval: 'auto-in-sandbox' } });
  assert.equal(inSandbox.autoApprove, true);
  assert.equal(inSandbox.promptOnSandboxEscape, true);

  const autoAll = provider.deriveProviderOptions({ settings: { acceptEditsApproval: 'auto-all' } });
  assert.equal(autoAll.autoApprove, true);
  assert.equal(autoAll.promptOnSandboxEscape, false);

  for (const subagentsDisabled of [undefined, false, true, 'true']) {
    assert.equal(
      provider.deriveProviderOptions({ settings: { subagentsDisabled } }).providerSubagentsEnabled,
      subagentsDisabled !== true
    );
  }
  for (const commandDescriptionsEnabled of [undefined, false, true, 'false']) {
    assert.equal(
      provider.deriveProviderOptions({ settings: { commandDescriptionsEnabled } }).commandDescriptionsEnabled,
      commandDescriptionsEnabled !== false
    );
  }
  assert.ok(provider.experimental_nativeSkillRoots.user.includes('.gemini/antigravity-cli/skills'));
  const userRootPaths = provider.experimental_nativeSkillRoots.user.map(
    root => (typeof root === 'string' ? root : root.path)
  );
  assert.ok(
    !userRootPaths.includes('.gemini/antigravity-cli/builtin/skills'),
    'internal CLI builtin/skills must stay internal to agy so /swarm and internal worker prompts do not duplicate in BB Skills'
  );
  assert.ok(userRootPaths.includes('.gemini/config/skills'));
  assert.ok(userRootPaths.includes('.agents/skills'));
  assert.ok(
    userRootPaths.indexOf('.gemini/config/skills') < userRootPaths.indexOf('.agents/skills'),
    'Antigravity-specific user skill roots must take precedence over the cross-agent .agents/skills fallback'
  );
  assert.ok(provider.experimental_nativeSkillRoots.project.some(
    root => typeof root === 'object' && root.path === '.agents/skills' && root.ancestors === true
  ));
  assert.equal(provider.capabilities.fork, 'tip');
  assert.equal(provider.capabilities.supportsManualCompaction, true);
  assert.equal(provider.models.scope, 'host');
  assert.equal(typeof provider.strings.planModeCopy, 'string');
  assert.deepEqual(provider.env.passthrough, [
    'BB_ANTIGRAVITY_GEMINI_DIR',
    'BB_ANTIGRAVITY_APP_DATA_DIR',
    'BB_AGY_ACP_PROXY',
    'AGY_CLI_AUTO_COMPACT_OVERRIDE',
  ]);
});

test('Swarm board refreshes its target after the thread timeline changes', async () => {
  const events = new Map();
  const called = [];
  const invalidations = [];
  let handlers;
  let identityReads = 0;
  let providerThreadId = 'original-session';
  const thread = { id: 't', providerId: 'antigravity-plus' };
  await plugin({
    settings: { define() { return {}; } },
    providers: { register() {} },
    hosts: {
      experimental_client() {
        return {
          async call(_method, params, { hostId }) {
            called.push({ ...params, hostId });
            return {};
          },
        };
      },
    },
    rpc: {
      register(contract, registered) {
        if (registered.getSwarmBoard) handlers = registered;
      },
      experimental_invalidate(keys) { invalidations.push(keys); },
    },
    events: { on(event, handler) { events.set(event, handler); } },
    sdk: {
      threads: {
        async get() { return { thread, environment: { hostId: 'agent-host' } }; },
        events: {
          async list() {
            identityReads += 1;
            return [{ data: { providerThreadId } }];
          },
        },
      },
    },
  });
  const context = { experimental_signal: new AbortController().signal };
  await handlers.getSwarmBoard({ threadId: thread.id }, context);
  await handlers.getSwarmBoard({ threadId: thread.id }, context);
  assert.equal(identityReads, 1);
  providerThreadId = 'replacement-session';
  events.get('experimental_thread.events')({ thread, sequence: 2 });
  assert.deepEqual(invalidations, [['swarm:t']]);
  await handlers.getSwarmBoard({ threadId: thread.id }, context);
  assert.equal(identityReads, 2);
  assert.deepEqual(called.at(-1), { providerThreadId: 'replacement-session', hostId: 'agent-host' });
});
