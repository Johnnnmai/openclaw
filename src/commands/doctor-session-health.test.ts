import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveSessionHealth, formatSessionHealthIssues, type SessionHealthIssue } from "./doctor-session-health.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("doctor-session-health", () => {
  const testDir = path.join(os.tmpdir(), `openclaw-test-${Date.now()}`);

  beforeEach(() => {
    vi.restoreAllMocks();
    // Clean up test directory
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe("resolveSessionHealth", () => {
    it("returns empty summary when no sessions exist", async () => {
      // Mock resolveStateDir to return our test directory
      vi.mock("../config/paths.js", () => ({
        resolveStateDir: () => testDir,
      }));

      // Mock resolveAgentSessionDirs
      vi.mock("../agents/session-dirs.js", () => ({
        resolveAgentSessionDirs: async () => [testDir],
      }));

      const summary = await resolveSessionHealth();
      expect(summary.totalSessions).toBe(0);
      expect(summary.issues).toHaveLength(0);
    });

    it("detects large session files", async () => {
      // Create test structure
      const sessionsDir = path.join(testDir, "sessions");
      const sessionDir = path.join(sessionsDir, "test-session");
      fs.mkdirSync(sessionDir, { recursive: true });

      // Create a large store.json file (over 10MB threshold)
      const storePath = path.join(sessionDir, "store.json");
      const largeContent = "x".repeat(11 * 1024 * 1024); // 11MB
      fs.writeFileSync(storePath, largeContent);

      vi.mock("../config/paths.js", () => ({
        resolveStateDir: () => testDir,
      }));

      vi.mock("../agents/session-dirs.js", () => ({
        resolveAgentSessionDirs: async () => [sessionsDir],
      }));

      const summary = await resolveSessionHealth({ largeFileThresholdBytes: 10 * 1024 * 1024 });

      expect(summary.totalSessions).toBe(1);
      expect(summary.issues).toHaveLength(1);
      expect(summary.issues[0].type).toBe("large_file");
      expect(summary.issues[0].severity).toBe("warning");
    });

    it("detects missing transcript directories", async () => {
      const sessionsDir = path.join(testDir, "sessions");
      const sessionDir = path.join(sessionsDir, "test-session");
      fs.mkdirSync(sessionDir, { recursive: true });

      // Create store.json but no transcripts directory
      fs.writeFileSync(path.join(sessionDir, "store.json"), "{}");

      vi.mock("../config/paths.js", () => ({
        resolveStateDir: () => testDir,
      }));

      vi.mock("../agents/session-dirs.js", () => ({
        resolveAgentSessionDirs: async () => [sessionsDir],
      }));

      const summary = await resolveSessionHealth();

      expect(summary.totalSessions).toBe(1);
      expect(summary.issues).toHaveLength(1);
      expect(summary.issues[0].type).toBe("missing_transcript");
    });

    it("detects stale lock files", async () => {
      const sessionsDir = path.join(testDir, "sessions");
      const sessionDir = path.join(sessionsDir, "test-session");
      fs.mkdirSync(sessionDir, { recursive: true });

      // Create a stale lock file
      const lockPath = path.join(sessionDir, "write.lock");
      fs.writeFileSync(lockPath, "");

      // Make the file appear old (31 minutes ago)
      const oldTime = new Date(Date.now() - 31 * 60 * 1000);
      fs.utimesSync(lockPath, oldTime, oldTime);

      vi.mock("../config/paths.js", () => ({
        resolveStateDir: () => testDir,
      }));

      vi.mock("../agents/session-dirs.js", () => ({
        resolveAgentSessionDirs: async () => [sessionsDir],
      }));

      const summary = await resolveSessionHealth();

      expect(summary.totalSessions).toBe(1);
      expect(summary.issues).toHaveLength(1);
      expect(summary.issues[0].type).toBe("stale_lock");
    });

    it("ignores fresh lock files", async () => {
      const sessionsDir = path.join(testDir, "sessions");
      const sessionDir = path.join(sessionsDir, "test-session");
      fs.mkdirSync(sessionDir, { recursive: true });

      // Create a fresh lock file
      const lockPath = path.join(sessionDir, "write.lock");
      fs.writeFileSync(lockPath, "");

      vi.mock("../config/paths.js", () => ({
        resolveStateDir: () => testDir,
      }));

      vi.mock("../agents/session-dirs.js", () => ({
        resolveAgentSessionDirs: async () => [sessionsDir],
      }));

      const summary = await resolveSessionHealth();

      // Should not detect fresh lock as an issue
      const lockIssues = summary.issues.filter((i) => i.type === "stale_lock");
      expect(lockIssues).toHaveLength(0);
    });
  });

  describe("formatSessionHealthIssues", () => {
    it("returns empty array for no issues", () => {
      const result = formatSessionHealthIssues([]);
      expect(result).toHaveLength(0);
    });

    it("formats issues by type", () => {
      const issues: SessionHealthIssue[] = [
        {
          type: "large_file",
          sessionKey: "session-1",
          message: "store.json is 15MB",
          severity: "warning",
        },
        {
          type: "large_file",
          sessionKey: "session-2",
          message: "store.json is 20MB",
          severity: "warning",
        },
        {
          type: "missing_transcript",
          sessionKey: "session-3",
          message: "transcripts directory missing",
          severity: "warning",
        },
      ];

      const result = formatSessionHealthIssues(issues);

      expect(result).toContain("- large file: 2 issues");
      expect(result).toContain("- missing transcript: 1 issue");
    });

    it("limits examples to 3 per type", () => {
      const issues: SessionHealthIssue[] = Array.from({ length: 5 }, (_, i) => ({
        type: "large_file",
        sessionKey: `session-${i}`,
        message: `store.json is ${10 + i}MB`,
        severity: "warning" as const,
      }));

      const result = formatSessionHealthIssues(issues);

      expect(result).toContain("... and 2 more");
    });
  });
});
