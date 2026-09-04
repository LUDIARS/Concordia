import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectCodesRepo } from "../src/db/project-codes-repo.js";
import { makeTestApp } from "./helpers/test-app.js";

describe("Cc workflow context injection", () => {
  it("defaults cc_workflow to null", async () => {
    const env = makeTestApp();
    const response = await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ccwf-off",
        provider: "codex-cli",
        repo_path: "/work/Concordia",
        branch: "main",
        host: "host",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.context_packet.cc_workflow).toBeNull();
  });

  it("returns startup workflow instructions with task API and PR completion policy", async () => {
    const env = makeTestApp();
    env.adminState.setCcWorkflowEnabled(true);
    const response = await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ccwf",
        provider: "codex-cli",
        repo_path: "/work/Concordia",
        branch: "main",
        host: "host",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    const workflow = body.context_packet.cc_workflow;
    expect(workflow.inject_source).toBe("session-start:cc-workflow");
    expect(workflow.task_api.update_todos).toContain("/v1/sessions/ccwf/event");
    expect(workflow.rules.join("\n")).toContain("task_update");
    expect(workflow.rules.join("\n")).toContain("open a PR");
    expect(workflow.interrupt_policy).toContain("append");
    expect(workflow.completion_policy.join("\n")).toContain("commit, push, and PR creation");
    expect(workflow.completion_policy.join("\n")).toContain("user explicitly adds that instruction");
  });

  it("also exposes the same workflow through GET /context", async () => {
    const env = makeTestApp();
    env.adminState.setCcWorkflowEnabled(true);
    await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ccwf-context",
        provider: "codex-cli",
        repo_path: "/work/Concordia",
        branch: "main",
        host: "host",
      }),
    });

    const response = await env.app.request("/v1/sessions/ccwf-context/context");
    const body = await response.json() as any;
    expect(body.context_packet.cc_workflow.task_api.list_pending).toContain("/pending-tasks");
  });

  it("uses project-code registry names when selecting relevant session logs", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-context-"));
    try {
      const logs = join(root, "session-logs");
      mkdirSync(logs);
      writeFileSync(join(logs, "2026-09-04.md"), "# 引き継ぎ\n\nConcordia の設定を更新した。", "utf-8");

      const env = makeTestApp();
      env.adminState.setWorkspaceRoots([root]);
      new ProjectCodesRepo(env.db).register({
        code: "Cc",
        project: "Concordia",
        repoPath: "/work/Concordia",
        repoOrigin: null,
        addedBy: "test",
      });

      const response = await env.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "ccwf-project-log",
          provider: "codex-cli",
          repo_path: "/work/Concordia",
          branch: "main",
          host: "host",
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.context_packet.relevant_session_logs).toMatchObject([
        { id: "2026-09-04", projects: ["Concordia"] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
