/**
 * IAgent — the interface every agent driver must implement.
 *
 * To add a new agent (Codex, Aider, Cline, etc.):
 *   1. Create src/agents/YourAgent.ts implementing IAgent
 *   2. Register it in src/agents/registry.ts
 *   3. It's available via `agentbox run --agent your-agent ./project`
 */

export interface AgentSetupOptions {
  /** Sandbox workspace directory (what the agent sees as its root) */
  workspaceDir: string;
  /** Fake HOME directory with minimal config + auth */
  fakeHomeDir: string;
  /** Extra CLI arguments to pass through to the agent binary */
  agentArgs?: string[];
  /** Whether to inject a sandbox notice into the project (e.g. CLAUDE.md) */
  injectNotice?: boolean;
}

export interface AgentSetup {
  /** Resolved path to the agent binary (or 'npx') */
  command: string;
  /** Arguments to pass to the binary */
  args: string[];
  /** Environment variables for the agent process */
  env: Record<string, string>;
}

export interface IAgent {
  /** Human-readable name shown in the UI */
  readonly name: string;
  /** Short identifier used in --agent flag (e.g. 'claude', 'codex', 'aider') */
  readonly id: string;

  /**
   * Prepare the agent: resolve binary, build env, inject any context files.
   * Called once before the sandbox launches the process.
   */
  setup(opts: AgentSetupOptions): Promise<AgentSetup>;

  /**
   * Clean up anything the agent injected into the workspace after the session.
   * Called after the sandbox process exits, before the diff is shown.
   */
  cleanup(workspaceDir: string): Promise<void>;
}
