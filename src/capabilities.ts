import type { Agent, AgentSelection, ReasoningLevel } from './types.js';

export interface AgentCapability { id: Agent; models: string[]; reasoningLevels: ReasoningLevel[]; defaults: { model: string; reasoningLevel?: ReasoningLevel } }
export interface Capabilities { agents: AgentCapability[]; defaults: { agent: Agent } }

const safeList = (value: string | undefined, fallback: string[]) => {
  const values = value?.split(',').map((item) => item.trim()).filter((item) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item));
  return values?.length ? [...new Set(values)] : fallback;
};

const validReasoningLevels: ReasoningLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function buildCapabilities(input: { codexModels?: string; codexDefaultModel?: string; codexReasoningLevels?: string; codexDefaultReasoning?: string; claudeModels?: string; claudeDefaultModel?: string; claudeReasoningLevels?: string; claudeDefaultReasoning?: string; defaultAgent?: string; allowMock?: boolean }): Capabilities {
  const codexModels = safeList(input.codexModels, safeList(input.codexDefaultModel, ['gpt-5-codex']));
  const codexReasoning = safeList(input.codexReasoningLevels, ['low', 'medium', 'high']).filter((item): item is ReasoningLevel => validReasoningLevels.includes(item as ReasoningLevel));
  const claudeModels = safeList(input.claudeModels, safeList(input.claudeDefaultModel, ['sonnet', 'opus']));
  const claudeReasoning = input.claudeReasoningLevels ? safeList(input.claudeReasoningLevels, []).filter((item): item is ReasoningLevel => validReasoningLevels.includes(item as ReasoningLevel)) : [];
  const codexDefault = codexModels.includes(input.codexDefaultModel ?? '') ? input.codexDefaultModel! : codexModels[0]!;
  const codexReasoningDefault = codexReasoning.includes(input.codexDefaultReasoning as ReasoningLevel) ? input.codexDefaultReasoning as ReasoningLevel : codexReasoning[0]!;
  const claudeDefault = claudeModels.includes(input.claudeDefaultModel ?? '') ? input.claudeDefaultModel! : claudeModels[0]!;
  const claudeReasoningDefault = claudeReasoning.length > 0 && claudeReasoning.includes(input.claudeDefaultReasoning as ReasoningLevel) ? input.claudeDefaultReasoning as ReasoningLevel : claudeReasoning[0];
  const agents: AgentCapability[] = [
    { id: 'codex', models: codexModels, reasoningLevels: codexReasoning, defaults: { model: codexDefault, reasoningLevel: codexReasoningDefault } },
    { id: 'claude', models: claudeModels, reasoningLevels: claudeReasoning, defaults: { model: claudeDefault, reasoningLevel: claudeReasoningDefault } },
  ];
  if (input.allowMock) agents.push({ id: 'mock', models: ['mock'], reasoningLevels: [], defaults: { model: 'mock' } });
  const requested = input.defaultAgent as Agent;
  return { agents, defaults: { agent: agents.some((agent) => agent.id === requested) ? requested : (input.allowMock && input.defaultAgent === 'mock' ? 'mock' : 'codex') } };
}

export function validateSelection(capabilities: Capabilities, input: Partial<AgentSelection>, fallback?: Partial<AgentSelection>): AgentSelection {
  const agent = input.agent ?? fallback?.agent ?? capabilities.defaults.agent;
  const capability = capabilities.agents.find((item) => item.id === agent);
  if (!capability) throw Object.assign(new Error('Agent is not configured'), { statusCode: 400 });
  const model = input.model ?? (fallback?.agent === agent ? fallback.model : undefined) ?? capability.defaults.model;
  if (!capability.models.includes(model)) throw Object.assign(new Error('Model is not allowed for the selected agent'), { statusCode: 400 });
  const reasoningLevel = input.reasoningLevel ?? (fallback?.agent === agent ? fallback.reasoningLevel : undefined) ?? capability.defaults.reasoningLevel;
  if (capability.reasoningLevels.length > 0 && reasoningLevel && !capability.reasoningLevels.includes(reasoningLevel)) {
    throw Object.assign(new Error(`Reasoning level is not allowed for ${agent}`), { statusCode: 400 });
  }
  if (capability.reasoningLevels.length === 0 && input.reasoningLevel !== undefined) {
    throw Object.assign(new Error(`Reasoning level is not supported by ${agent}`), { statusCode: 400 });
  }
  return { agent, model, ...(reasoningLevel ? { reasoningLevel } : {}) };
}
