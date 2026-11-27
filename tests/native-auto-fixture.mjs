// Drives host.ts with BB Auto through the real shared ACP bridge.
// argv: <permissionMode> <promptMode|-> [--no-auto]
import { fileURLToPath } from 'node:url';
const { experimental_providerBridge: bridge } = await import('../host.ts');

const [permissionMode, promptMode, ...agentFlags] = process.argv.slice(2);
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
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out: ' + JSON.stringify(messages));
};
const policy = permissionMode === 'auto'
  ? { permissionMode: 'auto', permissionScope: 'workspace', approvalReviewer: 'automatic', permissionEscalation: 'ask' }
  : { permissionMode: 'accept-edits', permissionScope: 'workspace', approvalReviewer: 'user', permissionEscalation: 'ask' };
const options = {
  ...policy,
  ...(promptMode === 'plan' ? { promptMode: 'plan' } : {}),
  providerOptions: { acpLaunchSpec: { displayName: 'Fake', command: process.execPath, args: [fileURLToPath(new URL('./fake-acp-modes.mjs', import.meta.url)), ...agentFlags], env: {} } },
};
let exitCode = 0;
try {
  send(1, 'initialize', { protocolVersion: 1, client: { name: 'test', version: '1' } });
  await wait(m => m.id === 1);
  send(2, 'thread/start', { threadId: 'thread', cwd: process.cwd(), instructionMode: 'append', options });
  const started = await wait(m => m.id === 2);
  if (!started.result?.providerThreadId) throw new Error('thread/start failed: ' + JSON.stringify(started));
  send(3, 'turn/start', { threadId: 'thread', providerThreadId: started.result.providerThreadId, clientRequestId: 'creq_23456789ab', input: [{ type: 'text', text: 'hi' }], options });
  const turn = await wait(m => m.id === 3);
  if (turn.error) throw new Error('turn/start failed: ' + JSON.stringify(turn.error));
  const reply = await wait(m => /active-mode=/.test(JSON.stringify(m)));
  originalWrite(`RESULT ${JSON.stringify(reply).match(/active-mode=([a-z-]+)/)[1]}\n`);
  const warned = messages.some(m => m.method === 'thread/delta' && m.params.deltas.some(d => d.kind === 'provider.warning' && /Auto is not available/.test(d.summary)));
  originalWrite(`WARNED ${warned}\n`);
} catch (error) {
  originalWrite(`ERROR ${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
}
bridge.onClose?.();
process.exit(exitCode);
