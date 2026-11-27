// Minimal ACP agent that advertises agy's native session modes and reports the
// active mode in each reply. Pass --no-auto to emulate an account without Auto.
import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const withAuto = !process.argv.includes('--no-auto');
const modes = ['default', 'accept-edits', 'plan', ...(withAuto ? ['auto'] : [])];
let current = 'default';
let pendingPromptId;
// Real agy reports both legacy modes and a "mode" config option.
const modeState = () => ({
  currentModeId: current,
  availableModes: modes.map(id => ({ id, name: id, description: id })),
});
const configOptions = () => [{
  id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: current,
  options: modes.map(value => ({ value, name: value, description: value })),
}];
const setMode = (id, value) => {
  if (!modes.includes(value)) {
    send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown mode ${value}` } });
    return false;
  }
  current = value;
  return true;
};
function finishPrompt(id) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'modes-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `active-mode=${current}` } } } });
  reply(id, { stopReason: 'end_turn' });
}
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'fake-modes', version: '1' } });
  else if (m.method === 'session/new' || m.method === 'session/load' || m.method === 'session/resume') reply(m.id, { sessionId: 'modes-session', modes: modeState(), configOptions: configOptions() });
  else if (m.method === 'session/set_config_option' && m.params.configId === 'mode') {
    if (setMode(m.id, m.params.value)) reply(m.id, { configOptions: configOptions() });
  } else if (m.method === 'session/set_mode') {
    if (!setMode(m.id, m.params.modeId)) return;
    reply(m.id, {});
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'modes-session', update: { sessionUpdate: 'current_mode_update', currentModeId: current } } });
  } else if (m.method === 'session/prompt') {
    if (!m.params.prompt.some(part => part.text === 'ask permission')) return finishPrompt(m.id);
    pendingPromptId = m.id;
    send({
      jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission',
      params: {
        sessionId: 'modes-session',
        toolCall: { toolCallId: 'permission-tool', kind: 'other', title: 'Escalated tool' },
        options: [
          { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
          { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
        ],
      },
    });
  } else if (m.id === 'permission-1' && !m.method) {
    finishPrompt(pendingPromptId);
  } else if (m.id !== undefined && m.method) reply(m.id, {});
});
