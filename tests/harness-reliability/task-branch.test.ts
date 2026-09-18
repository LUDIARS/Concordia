import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { TaskBranchService } from "../../src/harness/reliability/task-branch-service.js";
import { checkSubmittedTask, taskStartWarning, type SubmittedTask } from "../../src/harness/reliability/task-branch-policy.js";
import { makeTestDb } from "../helpers/db.js";
import { SessionsRepo } from "../../src/db/sessions-repo.js";
import { analyzePromptWithLocalLlm } from "../../src/harness/local-prompt-analyzer.js";
import { Hono } from "hono";
import { harnessSessionRouter } from "../../src/api/harness-session.js";
import { HarnessAuditRepo } from "../../src/db/harness-audit-repo.js";
import { HarnessRulesRepo } from "../../src/db/harness-rules-repo.js";

const submitted: SubmittedTask = { repo: resolve("fixture"), branch: "feature/score", task: "score", pr: "pr-1", relation: "unknown", version: 1 };

describe("submitted work boundary", () => {
  it("does not confuse a new task with review fixes even when the classifier says same-task", () => {
    expect(checkSubmittedTask({ ...submitted, submitted: { ...submitted, relation: "same-task" }, task: "UI colors" })?.decision).toBe("deny");
    expect(checkSubmittedTask({ ...submitted, submitted: { ...submitted, relation: "same-task" } })).toBeNull();
    expect(checkSubmittedTask({ ...submitted, submitted })?.decision).toBe("deny");
    expect(checkSubmittedTask({ ...submitted, submitted, branch: "feature/new" })).toBeNull();
  });

  it("warns before starting away from main, including an unknown checkout", () => {
    expect(taskStartWarning("main")).toBe("");
    expect(taskStartWarning("feature/old")).toContain("main");
    expect(taskStartWarning(undefined)).toContain("不明");
  });

  it("keeps unresolved classifier output unknown", async () => {
    const unavailable = await analyzePromptWithLocalLlm({ prompt: "change the UI", submittedTask: "score", rules: [], gates: [] }, {
      fetchImpl: async () => { throw new Error("offline"); },
    });
    expect(unavailable.analysis.task_relation).not.toBe("same-task");
  });

  it("gives the classifier the submitted task and preserves its relation", async () => {
    const result = await analyzePromptWithLocalLlm({ prompt: "change the UI", submittedTask: "score", rules: [], gates: [] }, {
      fetchImpl: async (_url, init) => {
        expect(String(init?.body)).toContain("score");
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ task_relation: "new-task" }) } }] }));
      },
    });
    expect(result.analysis.task_relation).toBe("new-task");
  });

  it("persists submission, rejects stale classifications and enforces the API gate", async () => {
    const db = makeTestDb();
    try {
      const sessions = new SessionsRepo(db);
      sessions.insertSession({ id: "task-test", provider: "claude-code", repo_path: submitted.repo, repo_origin: null,
        branch: submitted.branch, host: "fixture", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: '{"unrelated":true}' });
      sessions.patchSession("task-test", { current_task: submitted.task });
      const service = new TaskBranchService(sessions, async () => ({ repo: submitted.repo, branch: submitted.branch, mainExists: true }));
      service.submitted("task-test", submitted, submitted.pr);
      const older = service.beginClassification("task-test");
      const newer = service.beginClassification("task-test");
      service.classify("task-test", older, "same-task");
      expect(service.read("task-test")?.relation).toBe("unknown");
      service.classify("task-test", newer, "same-task");
      expect(await service.gate("task-test", { tool: "Edit", cwd: submitted.repo })).toBeNull();
      sessions.patchSession("task-test", { current_task: "UI colors" });
      const app = new Hono();
      app.route("/v1/harness", harnessSessionRouter({ audit: new HarnessAuditRepo(db), rules: new HarnessRulesRepo(db), taskBranches: service }));
      const response = await app.request("/v1/harness/gate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: "task-test", action: { tool: "Edit", cwd: submitted.repo, branch: submitted.branch, filePath: resolve("fixture/a.ts") } }) });
      expect(response.status).toBe(200);
      const verdict = await response.json() as { blocked: boolean; hits: { rule: string }[] };
      expect(verdict.blocked).toBe(true);
      expect(verdict.hits.some(hit => hit.rule === "submitted-task-boundary")).toBe(true);
      expect(JSON.parse(sessions.findSession("task-test")!.metadata!).unrelated).toBe(true);
      expect(await service.gate("task-test", { tool: "Bash", command: "git status" })).toBeNull();
    } finally { db.close(); }
  });
});
