// @spec 新規起動セッションのGitフック
import { afterEach, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { sessionPushCheckRouter } from "./session-push-check.js";
import * as context from "../implementation-tools/repo-context.js";
import type { RevisorRepositoryRecord } from "../pr/revisor-repository-client.js";

afterEach(() => vi.restoreAllMocks());

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
