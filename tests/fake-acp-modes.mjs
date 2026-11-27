// Minimal ACP agent that advertises agy's native session modes and reports the
// active mode in each reply. Pass --no-auto to emulate an account without Auto.
import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const withAuto = !process.argv.includes('--no-auto');
const modes = ['default', 'accept-edits', 'plan', ...(withAuto ? ['auto'] : [])];
let current = 'default';
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
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'modes-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `active-mode=${current}` } } } });
    reply(m.id, { stopReason: 'end_turn' });
  } else if (m.id !== undefined && m.method) reply(m.id, {});
});
