import type { AgentDefinition, AgentResumeRequest } from "@pragma-sh/plugin/catalog";
import type { PragmaClient } from "@pragma-sh/sdk";

import { pluginContext, qualifiedAgentId, winningPlugins, type ResolvedPlugin } from "./catalog";

/** What a resume needs from the host, without the correlation id. */
export interface AgentResumeQuery {
  /** Qualified catalog agent id (`pluginId.agentId`). */
  agentId: string;
  /** Project root the session ran in; picks a project override over a global plugin. */
  projectRoot: string;
  /** The harness session id, original selection, and cwd to resume. */
  request: AgentResumeRequest;
}

/** A plugin and the agent definition that builds the resume argv. */
export interface ResumableAgent {
  plugin: ResolvedPlugin;
  agent: AgentDefinition;
}

/**
 * Finds the winning agent for `agentId` for `projectRoot`: a project-scoped
 * plugin's copy overrides the global one, exactly like catalog assembly.
 */
export function findResumableAgent(
  plugins: ResolvedPlugin[],
  agentId: string,
  projectRoot: string,
): ResumableAgent | undefined {
  for (const plugin of winningPlugins(plugins, projectRoot)) {
    const agent = (plugin.definition.agents ?? []).find(
      (candidate) => qualifiedAgentId(plugin.pluginId, candidate.id) === agentId,
    );
    if (agent) return { plugin, agent };
  }
  return undefined;
}

/**
 * Asks the agent's plugin to build the full argv that resumes a harness
 * session, then validates it before it can reach a shell. A missing agent, an
 * agent without a `resume` callback, a rejecting callback, and a malformed
 * argv all surface as errors so the sidecar answers its correlated request
 * with `error` instead of a half-built command.
 */
export async function resolveAgentResume(
  plugins: ResolvedPlugin[],
  sdk: PragmaClient,
  query: AgentResumeQuery,
): Promise<string[]> {
  const match = findResumableAgent(plugins, query.agentId, query.projectRoot);
  if (!match) {
    throw new Error(`agent not found: ${query.agentId}`);
  }
  const { resume } = match.agent.launch;
  if (typeof resume !== "function") {
    throw new Error(`agent does not support resume: ${query.agentId}`);
  }
  const argv = await resume(query.request, pluginContext(match.plugin, sdk, query.projectRoot));
  return validateResumeArgv(argv);
}

/**
 * Validates a plugin-built resume argv before it is typed into the session's
 * shell. The argv is used verbatim, so the executable must be a non-empty
 * string and no token may contain NUL, CR, or LF — those would let a plugin's
 * output terminate the command or start a second one. Empty arguments after
 * the executable are allowed: an empty string is a legitimate argv entry.
 */
export function validateResumeArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("resume returned no command");
  }
  const tokens = argv.map((token) => {
    if (typeof token !== "string") {
      throw new Error("resume returned a non-string argument");
    }
    if (/[\0\r\n]/.test(token)) {
      throw new Error("resume returned an argument containing a control character");
    }
    return token;
  });
  if (tokens[0] === "") {
    throw new Error("resume returned an empty executable");
  }
  return tokens;
}
