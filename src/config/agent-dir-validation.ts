import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";

export type AgentDirValidationIssue = {
  agentId: string;
  type: "missing" | "not_directory" | "not_accessible" | "permission_denied";
  path: string;
  message: string;
};

export type AgentDirValidationResult = {
  valid: boolean;
  issues: AgentDirValidationIssue[];
};

/**
 * Validate that all agent directories are accessible and valid.
 */
export function validateAgentDirs(cfg: OpenClawConfig): AgentDirValidationResult {
  const issues: AgentDirValidationIssue[] = [];

  // Get all agent IDs from config
  const agents = cfg.agents?.list ?? [];
  const agentIds = new Set<string>();

  // Add default agent
  const defaultAgentId = resolveDefaultAgentId(cfg);
  agentIds.add(defaultAgentId);

  // Add all configured agents
  for (const agent of agents) {
    if (agent?.id) {
      agentIds.add(agent.id);
    }
  }

  // Validate each agent directory
  for (const agentId of agentIds) {
    try {
      const agentDir = resolveAgentDir(cfg, agentId);

      if (!fs.existsSync(agentDir)) {
        issues.push({
          agentId,
          type: "missing",
          path: agentDir,
          message: `Agent directory does not exist: ${agentDir}`,
        });
        continue;
      }

      const stats = fs.statSync(agentDir);
      if (!stats.isDirectory()) {
        issues.push({
          agentId,
          type: "not_directory",
          path: agentDir,
          message: `Agent path exists but is not a directory: ${agentDir}`,
        });
        continue;
      }

      // Try to read the directory to check accessibility
      try {
        fs.readdirSync(agentDir);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("permission") || message.includes("EACCES")) {
          issues.push({
            agentId,
            type: "permission_denied",
            path: agentDir,
            message: `Permission denied accessing agent directory: ${agentDir}`,
          });
        } else {
          issues.push({
            agentId,
            type: "not_accessible",
            path: agentDir,
            message: `Cannot read agent directory: ${message}`,
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push({
        agentId,
        type: "not_accessible",
        path: "",
        message: `Error resolving agent directory: ${message}`,
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
