// Drives host.ts through the real shared ACP bridge with an agent that asks
// an ask_question-style elicitation, answers the resulting BB question card,
// and prints what bb showed and what the agent received.
import { fileURLToPath } from 'node:url';
const { experimental_providerBridge: bridge } = await import('../host.ts');

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
  throw new Error('Timed out: ' + JSON.stringify(messages).slice(0, 4000));
};
const answer = JSON.parse(process.argv[2]);
const options = {
  permissionMode: 'accept-edits', permissionScope: 'workspace', approvalReviewer: 'user', permissionEscalation: 'ask',
  providerOptions: { acpLaunchSpec: { displayName: 'Fake', command: process.execPath, args: [fileURLToPath(new URL('./fake-acp-question.mjs', import.meta.url))], env: {} } },
};
let exitCode = 0;
try {
  send(1, 'initialize', { protocolVersion: 1, client: { name: 'test', version: '1' } });
  await wait(m => m.id === 1);
  send(2, 'thread/start', { threadId: 'thread', cwd: process.cwd(), instructionMode: 'append', options });
  const started = await wait(m => m.id === 2);
  send(3, 'turn/start', { threadId: 'thread', providerThreadId: started.result.providerThreadId, clientRequestId: 'creq_23456789ab', input: [{ type: 'text', text: 'ask' }], options });
  const interaction = await wait(m => m.method === 'interaction/request');
  originalWrite(`CARD ${JSON.stringify(interaction.params.payload)}\n`);
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: interaction.id, result: { kind: 'user_answer', answers: answer } }));
  const replied = await wait(m => /elicitation-response=/.test(JSON.stringify(m)));
  const text = replied.params.deltas.find(d => typeof d.text === 'string' && d.text.includes('elicitation-response='))?.text
    ?? JSON.stringify(replied);
  originalWrite(`AGENT ${text.slice(text.indexOf('elicitation-response=') + 'elicitation-response='.length)}\n`);
} catch (error) {
  originalWrite(`ERROR ${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
}
bridge.onClose?.();
process.exit(exitCode);
