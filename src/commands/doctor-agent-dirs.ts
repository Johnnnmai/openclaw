import type { OpenClawConfig } from "../config/config.js";
import { validateAgentDirs } from "../config/agent-dir-validation.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

/**
 * Note agent directory validation issues in doctor output.
 */
export function noteAgentDirHealth(cfg: OpenClawConfig): void {
  const result = validateAgentDirs(cfg);

  if (result.valid) {
    return;
  }

  const lines: string[] = [
    `- Found ${result.issues.length} agent directory issue${result.issues.length === 1 ? "" : "s"}:`,
  ];

  for (const issue of result.issues) {
    const shortPath = issue.path ? shortenHomePath(issue.path) : "(unknown)";
    lines.push(`- ${issue.agentId}: ${issue.type} - ${shortPath}`);
  }

  lines.push("");
  lines.push("These issues may prevent the agent from functioning correctly.");

  note(lines.join("\n"), "Agent directories");
}
