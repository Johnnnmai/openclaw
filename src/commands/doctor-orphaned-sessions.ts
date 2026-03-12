import fs from "node:fs";
import path from "node:path";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { note } from "../terminal/note.js";

const DEFAULT_LARGE_FILE_THRESHOLD = 10 * 1024 * 1024; // 10MB

/**
 * Check for orphaned session directories that may indicate stuck processes.
 */
export type OrphanedSession = {
  sessionKey: string;
  path: string;
  ageMs: number;
  hasWriteLock: boolean;
  hasActivity: boolean;
};

export type OrphanedSessionReport = {
  orphaned: OrphanedSession[];
  checkedAt: number;
};

function formatAge(ageMs: number): string {
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

function checkForOrphanedSessions(
  sessionsDir: string,
  thresholdMs: number = 30 * 60 * 1000, // 30 minutes
): OrphanedSession[] {
  const orphaned: OrphanedSession[] = [];

  try {
    if (!fs.existsSync(sessionsDir)) {
      return orphaned;
    }

    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const sessionKey = entry.name;
      const sessionPath = path.join(sessionsDir, sessionKey);

      try {
        const stats = fs.statSync(sessionPath);
        const ageMs = Date.now() - stats.mtimeMs;

        // Check for write lock
        const lockPath = path.join(sessionPath, "write.lock");
        const hasWriteLock = fs.existsSync(lockPath);

        // Check for recent activity (has recent files)
        let hasActivity = false;
        try {
          const transcriptDir = path.join(sessionPath, "transcripts");
          if (fs.existsSync(transcriptDir)) {
            const transcriptFiles = fs.readdirSync(transcriptDir);
            if (transcriptFiles.length > 0) {
              const latestFile = path.join(transcriptDir, transcriptFiles[transcriptFiles.length - 1]);
              const fileStats = fs.statSync(latestFile);
              if (Date.now() - fileStats.mtimeMs < thresholdMs) {
                hasActivity = true;
              }
            }
          }
        } catch {
          // Ignore errors checking activity
        }

        // Consider orphaned if old and has write lock but no recent activity
        if (ageMs > thresholdMs && hasWriteLock && !hasActivity) {
          orphaned.push({
            sessionKey,
            path: sessionPath,
            ageMs,
            hasWriteLock,
            hasActivity,
          });
        }
      } catch {
        // Ignore errors for individual sessions
      }
    }
  } catch {
    // Ignore errors reading sessions directory
  }

  return orphaned;
}

/**
 * Note any orphaned sessions in the doctor output.
 */
export async function noteOrphanedSessions(params?: {
  thresholdMs?: number;
}): Promise<void> {
  const thresholdMs = params?.thresholdMs ?? 30 * 60 * 1000;

  try {
    const stateDir = resolveStateDir(process.env);
    const sessionsDir = path.join(stateDir, "sessions");

    const orphaned = checkForOrphanedSessions(sessionsDir, thresholdMs);

    if (orphaned.length === 0) {
      return;
    }

    const lines: string[] = [
      `- Found ${orphaned.length} potentially orphaned session${orphaned.length === 1 ? "" : "s"} (no recent activity but has write lock):`,
    ];

    // Show first few examples
    const examples = orphaned.slice(0, 5);
    for (const session of examples) {
      lines.push(`  - ${session.sessionKey}: age=${formatAge(session.ageMs)}`);
    }

    if (orphaned.length > 5) {
      lines.push(`  ... and ${orphaned.length - 5} more`);
    }

    lines.push("");
    lines.push("These sessions may have stuck processes. Run with --fix to attempt cleanup.");

    note(lines.join("\n"), "Orphaned sessions");
  } catch {
    // Ignore errors - this is a diagnostic check
  }
}
