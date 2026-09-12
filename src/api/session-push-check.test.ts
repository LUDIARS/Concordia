// @spec 新規起動セッションのGitフック
import { afterEach, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { sessionPushCheckRouter } from "./session-push-check.js";
import * as context from "../implementation-tools/repo-context.js";
import type { RevisorRepositoryRecord } from "../pr/revisor-repository-client.js";

afterEach(() => vi.restoreAllMocks());

it.each(["approved", "denied", "unavailable", "busy", "rebound", "ended", "remote", "injected", "exception", "root-changed"])(
  "requires a fresh human WARNING and stable binding: %s", async (scenario) => {
    const db = makeTestDb();
    try {
      const sessions = new SessionsRepo(db);
      const origin = "https://github.com/LUDIARS/Example.git";
      sessions.insertSession({ id: "warning-fixture", provider: "codex-cli", repo_path: "E:/workspace/repo",
        repo_origin: origin, branch: "feat/rewrite", host: "fixture", started_at: 1, last_seen_at: 1,
        transcript_path: null, metadata: null });
      vi.spyOn(context, "isWithinWorkspace").mockResolvedValue(true);
      vi.spyOn(context, "inspectImplementationRepo").mockResolvedValue({ repoPath: "E:/workspace/repo",
        repoOrigin: origin, branch: "feat/rewrite" });
      const repository = { repository: "LUDIARS/Example", rootPath: "E:/workspace/repo", baseRef: "main",
        testCases: [], workflow: "revisor" } as RevisorRepositoryRecord;
      let roots = ["E:/workspace"];
      const requestWarning = vi.fn(async () => {
        if (scenario === "exception") throw new Error("UI unavailable");
        if (scenario === "rebound") sessions.patchSession("warning-fixture", { branch: "main" });
        if (scenario === "ended") sessions.setStatus("warning-fixture", "ended", 2, 2);
        if (scenario === "root-changed") roots = ["E:/workspace/repo"];
        return ["denied", "unavailable", "busy"].includes(scenario) ? scenario as "denied" | "unavailable" | "busy" : "approved" as const;
      });
      const app = sessionPushCheckRouter({ sessions, workspaceRoots: () => roots,
        revisor: { listRepositories: async () => [repository] }, requestWarning });
      const response = await app.request("/warning-fixture/push-check", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "E:/workspace/repo", push: {
          remoteName: "origin", remoteUrl: scenario === "remote" ? "https://github.com/Other/Repo.git" : origin,
          updates: [{ localRef: "refs/heads/rewrite", localSha: "a".repeat(40), remoteRef: "refs/heads/main", remoteSha: "b".repeat(40) }],
          ...(scenario === "injected" ? { approved: true } : {}),
        } }) });
      expect(await response.json()).toMatchObject({ allowed: scenario === "approved" });
      expect(requestWarning).toHaveBeenCalledTimes(["remote", "injected"].includes(scenario) ? 0 : 1);
    } finally { db.close(); }
  });

it.each(["unregistered", "github", "revisor", "unavailable", "binding", "workspace-root"])(
  "enforces push policy for %s without a GitHub App", async (scenario) => {
    const db = makeTestDb();
    try {
      const sessions = new SessionsRepo(db);
      sessions.insertSession({ id: "push-fixture", provider: "codex-cli", repo_path: "E:/workspace/repo",
        repo_origin: "https://github.com/LUDIARS/Example.git", branch: "feat/push", host: "fixture",
        started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null });
      vi.spyOn(context, "isWithinWorkspace").mockResolvedValue(true);
      vi.spyOn(context, "inspectImplementationRepo").mockResolvedValue({
        repoPath: "E:/workspace/repo", repoOrigin: "https://github.com/LUDIARS/Example.git",
        branch: scenario === "binding" ? "main" : "feat/push",
      } as Awaited<ReturnType<typeof context.inspectImplementationRepo>>);
      const listRepositories = vi.fn(async (): Promise<RevisorRepositoryRecord[]> => {
        if (scenario === "unavailable") throw new Error("registry unavailable");
        return scenario === "github" || scenario === "revisor" ? [{ repository: "LUDIARS/Example",
          rootPath: "E:/workspace/repo", baseRef: "main", testCases: [], workflow: scenario }] : [];
      });
      const app = sessionPushCheckRouter({ sessions, revisor: { listRepositories },
        workspaceRoots: () => [scenario === "workspace-root" ? "E:/workspace/repo" : "E:/workspace"] });
      const response = await app.request("/push-fixture/push-check", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "E:/workspace/repo" }) });
      const allowed = scenario === "unregistered" || scenario === "github";
      expect(await response.json()).toMatchObject({ allowed });
      const events = sessions.recentEvents("push-fixture", 10);
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].payload)).toMatchObject({ allowed });
    } finally { db.close(); }
  });
