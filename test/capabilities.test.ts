import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCapabilities, validateSelection } from '../src/capabilities.js';

test('capabilities expose only configured safe selections and defaults', () => {
  const capabilities = buildCapabilities({ codexModels: 'codex-a,codex-b', codexDefaultModel: 'codex-b', codexReasoningLevels: 'low,high', codexDefaultReasoning: 'high', claudeModels: 'sonnet,opus', claudeDefaultModel: 'opus', defaultAgent: 'claude' });
  assert.deepEqual(capabilities.defaults, { agent: 'claude' });
  assert.deepEqual(capabilities.agents[0], { id: 'codex', models: ['codex-a', 'codex-b'], reasoningLevels: ['low', 'high'], defaults: { model: 'codex-b', reasoningLevel: 'high' } });
  assert.deepEqual(capabilities.agents[1], { id: 'claude', models: ['sonnet', 'opus'], reasoningLevels: [], defaults: { model: 'opus' } });
});

test('model and CLI-shaped injection values are rejected instead of forwarded', () => {
  const capabilities = buildCapabilities({ codexModels: 'codex-a', claudeModels: 'sonnet,opus' });
  for (const model of ['codex-a; touch /tmp/pwned', '--dangerously-skip-permissions', 'opus\n--allowedTools Bash']) {
    assert.throws(() => validateSelection(capabilities, { agent: model.startsWith('codex') ? 'codex' : 'claude', model, reasoningLevel: model.startsWith('codex') ? 'high' : undefined }), /not allowed/);
  }
  assert.throws(() => validateSelection(capabilities, { agent: 'claude', model: 'sonnet', reasoningLevel: 'high' }), /only by Codex/);
});

test('selection uses server defaults and inherits a run only for the same agent', () => {
  const capabilities = buildCapabilities({ codexModels: 'codex-a,codex-b', codexDefaultModel: 'codex-a', codexDefaultReasoning: 'medium', claudeModels: 'sonnet,opus' });
  assert.deepEqual(validateSelection(capabilities, {}, { agent: 'codex', model: 'codex-b', reasoningLevel: 'high' }), { agent: 'codex', model: 'codex-b', reasoningLevel: 'high' });
  assert.deepEqual(validateSelection(capabilities, { agent: 'claude' }, { agent: 'codex', model: 'codex-b', reasoningLevel: 'high' }), { agent: 'claude', model: 'sonnet' });
});
