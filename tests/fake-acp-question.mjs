// agy 1.5.18 sends a form with choices and a companion free-text field.
import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
let promptId;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'fake-question', version: '1' } });
  } else if (m.method === 'session/new') {
    reply(m.id, { sessionId: 'question-session' });
  } else if (m.method === 'session/prompt') {
    promptId = m.id;
    send({
      jsonrpc: '2.0', id: 'elicit-1', method: 'elicitation/create',
      params: {
        sessionId: 'question-session', toolCallId: 'call_1', mode: 'form',
        message: m.params.prompt.some(part => part.text === 'custom')
          ? 'Pick a color for the header.' : 'The agent has a question.',
        requestedSchema: {
          type: 'object',
          properties: {
            q1: { type: 'string', title: 'Which color do you prefer?', oneOf: [{ const: '1', title: 'Red' }, { const: '2', title: 'Green' }, { const: '3', title: 'Blue' }] },
            q1_other: { type: 'string', title: 'Other', description: 'Optional free-form answer to: Which color do you prefer?' },
          },
        },
      },
    });
  } else if (m.id === 'elicit-1' && !m.method) {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'question-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `elicitation-response=${JSON.stringify(m.result ?? m.error)}` } } } });
    reply(promptId, { stopReason: 'end_turn' });
  } else if (m.id !== undefined && m.method) {
    reply(m.id, {});
  }
});
