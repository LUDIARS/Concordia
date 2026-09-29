import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { TaskBranchService } from "../../src/harness/reliability/task-branch-service.js";
import { checkRegisteredCheckout, checkSubmittedTask, deterministicTaskRelation, describeSubmittedTask, readDeclaredTask, requiresTaskBranchCheck, SUBMITTED_BOUNDARY_RECOVERY, taskStartWarning, type SubmittedPrState, type SubmittedTask } from "../../src/harness/reliability/task-branch-policy.js";
import { makeTestDb } from "../helpers/db.js";
import { SessionsRepo } from "../../src/db/sessions-repo.js";
import { analyzePromptWithLocalLlm } from "../../src/harness/local-prompt-analyzer.js";
import { Hono } from "hono";
import { harnessSessionRouter } from "../../src/api/harness-session.js";
import { HarnessAuditRepo } from "../../src/db/harness-audit-repo.js";
import { HarnessRulesRepo } from "../../src/db/harness-rules-repo.js";

describe("registered checkout decides the task-branch boundary", () => {
  const main = resolve("fixture/app"), worktree = resolve("fixture/app-wt"), elsewhere = resolve("fixture/workspace");
  const registered = { repo: main, branch: "fix/gate" };
  const appRepo = { repo: main, branch: "main", mainExists: true, commonDir: resolve("fixture/app/.git"),
    checkouts: [{ repo: main, branch: "main" }, { repo: worktree, branch: "fix/gate" }] };
  const inWorktree = { repo: worktree, branch: "fix/gate", mainExists: true, commonDir: appRepo.commonDir };
  const outside = { repo: elsewhere, branch: "main", mainExists: true, commonDir: resolve("fixture/workspace/.git") };

  it("allows a linked worktree of the registered repository on the registered branch", () => {
    expect(checkRegisteredCheckout({ registered, acting: inWorktree, registeredRepo: appRepo, tool: "Edit" })).toBeNull();
    expect(checkRegisteredCheckout({ registered, acting: { ...inWorktree, branch: "feature/other" }, registeredRepo: appRepo, tool: "Edit" })?.rule).toBe("task-branch");
  });

  it("allows a command from a shell parked outside when the registration is real", () => {
    expect(checkRegisteredCheckout({ registered, acting: outside, registeredRepo: appRepo, tool: "Bash" })).toBeNull();
    expect(checkRegisteredCheckout({ registered: { ...registered, branch: "fix/gone" }, acting: outside, registeredRepo: appRepo, tool: "Bash" })?.decision).toBe("deny");
    expect(checkRegisteredCheckout({ registered, acting: outside, registeredRepo: null, tool: "Bash" })?.decision).toBe("deny");
  });

  it("still denies editing a checkout that is not registered", () => {
    expect(checkRegisteredCheckout({ registered, acting: outside, registeredRepo: appRepo, tool: "Edit" })?.decision).toBe("deny");
    expect(checkRegisteredCheckout({ registered: { ...registered, branch: "" }, acting: inWorktree, registeredRepo: appRepo, tool: "Bash" })?.decision).toBe("deny");
  });

  it("reads the registered checkout separately in the service", async () => {
    const db = makeTestDb();
    try {
      const sessions = new SessionsRepo(db);
      sessions.insertSession({ id: "reg-test", provider: "claude-code", repo_path: main, repo_origin: null,
        branch: "fix/gate", host: "fixture", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null });
      const snapshots: Record<string, typeof appRepo | typeof inWorktree | typeof outside> = { [main]: appRepo, [worktree]: inWorktree, [elsewhere]: outside };
      const service = new TaskBranchService(sessions, async (cwd) => snapshots[resolve(cwd)]!);
      expect(await service.gate("reg-test", { tool: "Bash", command: "node build.mjs", cwd: elsewhere })).toBeNull();
      expect(await service.gate("reg-test", { tool: "Edit", cwd: worktree })).toBeNull();
      expect((await service.gate("reg-test", { tool: "Edit", cwd: elsewhere }))?.rule).toBe("task-branch");
      // The registered path itself is on main, so acting there is a real mismatch.
      expect((await service.gate("reg-test", { tool: "Edit", cwd: main }))?.rule).toBe("task-branch");
    } finally { db.close(); }
  });
});

const submitted: SubmittedTask = { repo: resolve("fixture"), branch: "feature/score", task: "score", pr: "pr-1", relation: "unknown", version: 1 };

describe("submitted work boundary", () => {
  it("does not confuse a new task with review fixes even when the classifier says same-task", () => {
    expect(checkSubmittedTask({ ...submitted, submitted: { ...submitted, relation: "same-task", declared: true }, task: "UI colors" })?.decision).toBe("deny");
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
      sessions.mergeMetadata("task-test", { declared_task: submitted.task });
      const service = new TaskBranchService(sessions, async () => ({ repo: submitted.repo, branch: submitted.branch, mainExists: true }));
      service.submitted("task-test", submitted, submitted.pr);
      const older = service.beginClassification("task-test");
      const newer = service.beginClassification("task-test");
      service.classify("task-test", older, "same-task");
      expect(service.read("task-test")?.relation).toBe("unknown");
      service.classify("task-test", newer, "same-task");
      expect(await service.gate("task-test", { tool: "Edit", cwd: submitted.repo })).toBeNull();
      sessions.mergeMetadata("task-test", { declared_task: "UI colors" });
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

  it("tells a blocked session which exempt commands release it (TB-RECOVER)", () => {
    const hit = checkSubmittedTask({ ...submitted, submitted });
    expect(hit?.suggestion).toContain(SUBMITTED_BOUNDARY_RECOVERY);
    // 案内したコマンドが本当にゲートの対象外であること。対象内なら案内しても抜け出せない。
    for (const command of [
      'lictor cli task set --branch main --desc "done"',
      'lictor cli task set --branch fix/next --desc "next"',
      "git worktree add -b fix/next ../next main",
    ]) expect(requiresTaskBranchCheck({ tool: "Bash", command })).toBe(false);
  });
});

describe("merged submission releases the boundary (TB-MERGED)", () => {
  const edit = { tool: "Edit", cwd: submitted.repo };

  function setup(state: (pr: string) => Promise<SubmittedPrState>) {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    sessions.insertSession({ id: "merged-test", provider: "claude-code", repo_path: submitted.repo, repo_origin: null,
      branch: submitted.branch, host: "fixture", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: '{"unrelated":true}' });
    sessions.patchSession("merged-test", { current_task: "next task" });
    const service = new TaskBranchService(sessions, async () => ({ repo: submitted.repo, branch: submitted.branch, mainExists: true }), undefined, state);
    service.submitted("merged-test", submitted, submitted.pr);
    return { db, sessions, service };
  }

  it("releases the boundary once the submitted PR is merged", async () => {
    const asked: string[] = [];
    const { db, sessions, service } = setup(async (pr) => { asked.push(pr); return "merged"; });
    try {
      expect(await service.gate("merged-test", edit)).toBeNull();
      expect(asked).toEqual([submitted.pr]);
      expect(service.read("merged-test")).toBeNull();
      expect(JSON.parse(sessions.findSession("merged-test")!.metadata!).unrelated).toBe(true);
    } finally { db.close(); }
  });

  it("keeps the boundary while the PR is unmerged or unreadable", async () => {
    for (const state of ["unmerged", "unknown"] as const) {
      const { db, service } = setup(async () => state);
      try {
        expect((await service.gate("merged-test", edit))?.rule).toBe("submitted-task-boundary");
        expect(service.read("merged-test")?.pr).toBe(submitted.pr);
      } finally { db.close(); }
    }
  });

  it("keeps a newer submission recorded while the state was being read", async () => {
    let target: TaskBranchService | undefined;
    const { db, service } = setup(async () => {
      target?.submitted("merged-test", submitted, "pr-2");
      return "merged";
    });
    target = service;
    try {
      expect((await service.gate("merged-test", edit))?.rule).toBe("submitted-task-boundary");
      expect(service.read("merged-test")?.pr).toBe("pr-2");
    } finally { db.close(); }
  });
});

// 2026-09-29: current_task 列は人間の指示のたびに要約で上書きされるため、提出後の同一 PR 修正が
// 「別作業」扱いで止まっていた (Astra With Sidecar PR #2150)。 宣言タスクで比べ、PR を直接指す
// 指示は決定的に same-task とする。
describe("submitted boundary follows the declared task (TB-DECLARED)", () => {
  const labelled: SubmittedTask = { ...submitted, declared: true, label: "LUDIARS/Concordia#2150 feat: Astra With Sidecar" };

  it("does not compare legacy snapshots whose task was a prompt summary", () => {
    const legacy = { ...submitted, relation: "same-task" as const };
    expect(checkSubmittedTask({ ...submitted, submitted: legacy, task: "次の指示の要約" })).toBeNull();
    expect(checkSubmittedTask({ ...submitted, submitted: { ...legacy, relation: "unknown" }, task: "x" })?.decision).toBe("deny");
  });

  it("treats a prompt that names the submitted PR or branch as the same task", () => {
    expect(deterministicTaskRelation("PR 2150 の修正を続けて", labelled)).toBe("same-task");
    expect(deterministicTaskRelation("🔴 Revisor レビュー完了: LUDIARS/Concordia#2150 はマージできません。", labelled)).toBe("same-task");
    expect(deterministicTaskRelation("feature/score の指摘を直して", labelled)).toBe("same-task");
    expect(deterministicTaskRelation("PR 21500 を見て", labelled)).toBeNull();
    expect(deterministicTaskRelation("PR 2150 とは別に UI を直して", labelled)).toBeNull();
    expect(deterministicTaskRelation("色を変えて", labelled)).toBeNull();
    expect(deterministicTaskRelation("PR 2150 を直して", { ...labelled, label: undefined })).toBeNull();
  });

  it("describes the submitted PR to the classifier", () => {
    expect(describeSubmittedTask(labelled)).toBe("score (PR: LUDIARS/Concordia#2150 feat: Astra With Sidecar, branch: feature/score)");
    expect(describeSubmittedTask(submitted)).toBe("score");
  });

  it("records the declared task and label, and releases the gate on a direct PR reference", async () => {
    const db = makeTestDb();
    try {
      const sessions = new SessionsRepo(db);
      sessions.insertSession({ id: "decl-test", provider: "claude-code", repo_path: submitted.repo, repo_origin: null,
        branch: submitted.branch, host: "fixture", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null });
      sessions.mergeMetadata("decl-test", { declared_task: "Astra With Sidecar 実装" });
      sessions.patchSession("decl-test", { current_task: "次の作業の指示" });
      expect(readDeclaredTask(sessions.findSession("decl-test")!)).toBe("Astra With Sidecar 実装");
      const service = new TaskBranchService(sessions, async () => ({ repo: submitted.repo, branch: submitted.branch, mainExists: true }));
      service.submitted("decl-test", { repo: submitted.repo, branch: submitted.branch, label: labelled.label }, "pr-1");
      expect(service.read("decl-test")).toMatchObject({ task: "Astra With Sidecar 実装", declared: true, label: labelled.label });

      // 指示の要約が変わっても、宣言タスクが同じなら境界の同一性は保たれる。
      sessions.patchSession("decl-test", { current_task: "PR 2150 の修正を続けて" });
      const decided = service.beginClassification("decl-test", "PR 2150 の修正を続けて");
      expect(decided).toMatchObject({ relation: "same-task", decided: true });
      expect(await service.gate("decl-test", { tool: "Edit", cwd: submitted.repo })).toBeNull();

      // 別の指示は分類待ちに戻る。
      expect(service.beginClassification("decl-test", "色を変えて")?.decided).toBeUndefined();
      expect((await service.gate("decl-test", { tool: "Edit", cwd: submitted.repo }))?.rule).toBe("submitted-task-boundary");

      // 宣言そのものを別の作業へ変えたら、分類結果に関係なく拒否する。
      sessions.mergeMetadata("decl-test", { declared_task: "別の機能" });
      service.beginClassification("decl-test", "PR 2150 の修正を続けて");
      expect((await service.gate("decl-test", { tool: "Edit", cwd: submitted.repo }))?.reason).toContain("別作業");
    } finally { db.close(); }
  });
});
