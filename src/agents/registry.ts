import { IAgent } from './IAgent';
import { ClaudeCodeAgent } from './ClaudeCodeAgent';

/**
 * Agent registry — maps --agent flag values to agent driver instances.
 *
 * To register a new agent:
 *   import { YourAgent } from './YourAgent';
 *   registry.set('your-agent', new YourAgent());
 */
const registry = new Map<string, IAgent>();

// Built-in agents
registry.set('claude', new ClaudeCodeAgent());
registry.set('claude-code', new ClaudeCodeAgent()); // alias

export function getAgent(id: string): IAgent {
  const agent = registry.get(id.toLowerCase());
  if (!agent) {
    const available = [...registry.keys()].join(', ');
    throw new Error(
      `Unknown agent: "${id}". Available agents: ${available}\n` +
      `To add a new agent, implement IAgent and register it in src/agents/registry.ts`
    );
  }
  return agent;
}

export function listAgents(): { id: string; name: string }[] {
  const seen = new Set<string>();
  const result: { id: string; name: string }[] = [];
  for (const [id, agent] of registry) {
    if (!seen.has(agent.id)) {
      seen.add(agent.id);
      result.push({ id, name: agent.name });
    }
  }
  return result;
}

export { registry };
