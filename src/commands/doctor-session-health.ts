import fs from "node:fs";
import path from "node:path";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { resolveStateDir } from "../config/paths.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

const DEFAULT_SESSION_WARNING_COUNT = 100;

/**
 * Session health issue types for diagnostics.
 */
export type SessionHealthIssue = {
  type: "large_file" | "missing_transcript" | "corrupted_entry" | "stale_lock";
  sessionKey: string;
  message: string;
  severity: "warning" | "error";
};

/**
 * Session health summary.
 */
export type SessionHealthSummary = {
  totalSessions: number;
  issues: SessionHealthIssue[];
  checkedAt: number;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) {
    return "unknown";
  }
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes}m`;
}

/**
 * Check a single session directory for health issues.
 */
function checkSessionDir(
  sessionsDir: string,
  options?: { largeFileThresholdBytes?: number },
): SessionHealthIssue[] {
  const issues: SessionHealthIssue[] = [];
  const threshold = options?.largeFileThresholdBytes ?? 10 * 1024 * 1024; // 10MB default

  try {
    if (!fs.existsSync(sessionsDir)) {
      return issues;
    }

    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const sessionKey = entry.name;
      const sessionPath = path.join(sessionsDir, sessionKey);

      // Check for large session files
      try {
        const storePath = path.join(sessionPath, "store.json");
        if (fs.existsSync(storePath)) {
          const stats = fs.statSync(storePath);
          if (stats.size > threshold) {
            issues.push({
              type: "large_file",
              sessionKey,
              message: `store.json is ${formatSize(stats.size)} (threshold: ${formatSize(threshold)})`,
              severity: "warning",
            });
          }
        }
      } catch {
        // Ignore errors reading store
      }

      // Check for missing transcript directory
      try {
        const transcriptDir = path.join(sessionPath, "transcripts");
        if (!fs.existsSync(transcriptDir)) {
          issues.push({
            type: "missing_transcript",
            sessionKey,
            message: "transcripts directory is missing",
            severity: "warning",
          });
        }
      } catch {
        // Ignore errors checking transcript dir
      }

      // Check for stale lock files
      try {
        const lockPath = path.join(sessionPath, "write.lock");
        if (fs.existsSync(lockPath)) {
          const stats = fs.statSync(lockPath);
          const ageMs = Date.now() - stats.mtimeMs;
          // Consider lock stale after 30 minutes
          if (ageMs > 30 * 60 * 1000) {
            issues.push({
              type: "stale_lock",
              sessionKey,
              message: `write.lock is stale (age: ${formatAge(ageMs)})`,
              severity: "warning",
            });
          }
        }
      } catch {
        // Ignore errors checking lock file
      }
    }
  } catch {
    // Ignore errors reading session directory
  }

  return issues;
}

/**
 * Resolve the session health for all agent session directories.
 */
export async function resolveSessionHealth(params?: {
  largeFileThresholdBytes?: number;
}): Promise<SessionHealthSummary> {
  const issues: SessionHealthIssue[] = [];
  let totalSessions = 0;

  try {
    const stateDir = resolveStateDir(process.env);
    const sessionDirs = await resolveAgentSessionDirs(stateDir);

    for (const sessionsDir of sessionDirs) {
      const dirIssues = checkSessionDir(sessionsDir, {
        largeFileThresholdBytes: params?.largeFileThresholdBytes,
      });
      issues.push(...dirIssues);

      // Count sessions
      try {
        if (fs.existsSync(sessionsDir)) {
          const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
          totalSessions += entries.filter((e) => e.isDirectory()).length;
        }
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore errors resolving session dirs
  }

  return {
    totalSessions,
    issues,
    checkedAt: Date.now(),
  };
}

/**
 * Format session health issues for display in doctor output.
 */
export function formatSessionHealthIssues(issues: SessionHealthIssue[]): string[] {
  if (issues.length === 0) {
    return [];
  }

  const lines: string[] = [];
  const byType = new Map<string, SessionHealthIssue[]>();

  for (const issue of issues) {
    const existing = byType.get(issue.type) ?? [];
    existing.push(issue);
    byType.set(issue.type, existing);
  }

  for (const [type, typeIssues] of byType) {
    const typeLabel = type.replace(/_/g, " ");
    lines.push(`- ${typeLabel}: ${typeIssues.length} issue${typeIssues.length === 1 ? "" : "s"}`);

    // Show first few examples
    const examples = typeIssues.slice(0, 3);
    for (const issue of examples) {
      lines.push(`  - ${issue.sessionKey}: ${issue.message}`);
    }

    if (typeIssues.length > 3) {
      lines.push(`  ... and ${typeIssues.length - 3} more`);
    }
  }

  return lines;
}

/**
 * Note session health in doctor output.
 */
export async function noteSessionHealth(params?: {
  largeFileThresholdBytes?: number;
}): Promise<void> {
  const summary = await resolveSessionHealth(params);

  if (summary.totalSessions === 0) {
    return;
  }

  const lines: string[] = [
    `- Found ${summary.totalSessions} session${summary.totalSessions === 1 ? "" : "s"} in state directory.`,
  ];

  if (summary.issues.length > 0) {
    const errorCount = summary.issues.filter((i) => i.severity === "error").length;
    const warningCount = summary.issues.filter((i) => i.severity === "warning").length;

    if (errorCount > 0 || warningCount > 0) {
      lines.push(`- Found ${summary.issues.length} session issue${summary.issues.length === 1 ? "" : "s"} (${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${warningCount === 1 ? "" : "s"}).`);
    }

    const issueLines = formatSessionHealthIssues(summary.issues);
    lines.push(...issueLines);
  }

  note(lines.join("\n"), "Session health");
}
