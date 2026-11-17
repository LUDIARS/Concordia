/**
 * TB-ROOT-CMD の実経路: /v1/harness/gate で task-branch の deny が workspace root 配下のコマンドだけ warn になり、
 * 編集ツールと安全境界 (main 直 push) は deny のまま残ることを確かめる。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { resolve } from "node:path";
import { makeTestDb } from "../../tests/helpers/db.js";
import { HarnessAuditRepo } from "../db/harness-audit-repo.js";
import { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import { createHarnessBlackbox } from "../harness/blackbox-engine.js";
import { seedHarnessRules } from "../subsidiary/harness-seed.js";
import type { TaskBranchService } from "../harness/reliability/task-branch-service.js";
import { harnessSessionRouter } from "./harness-session.js";

const root = resolve("fixture/ars");
const inside = resolve("fixture/ars/Concordia");

function makeApp(roots: readonly string[]) {
  const db = makeTestDb();
  const rules = new HarnessRulesRepo(db);
  seedHarnessRules(rules);
  const taskBranches = { gate: async () => ({ rule: "task-branch", decision: "deny", reason: "checkout mismatch" }) } as unknown as TaskBranchService;
  const app = new Hono();
  app.route("/v1/harness", harnessSessionRouter({
    audit: new HarnessAuditRepo(db), rules, blackbox: createHarnessBlackbox(db), taskBranches,
    workspaceRootCommandRelaxRoots: () => roots,
  }));
  return app;
}

async function gate(app: Hono, action: Record<string, unknown>): Promise<{ decision: string; blocked: boolean; hits: Array<{ rule: string; decision: string }> }> {
  const res = await app.request("/v1/harness/gate", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, session_id: "sess-root" }) });
  return await res.json() as { decision: string; blocked: boolean; hits: Array<{ rule: string; decision: string }> };
}

describe("/v1/harness/gate workspace root command relax (TB-ROOT-CMD)", () => {
  beforeEach(() => {
    process.env.CONCORDIA_PROMPT_ANALYZER = "off";
    process.env.CONCORDIA_PROMPT_RESEARCH = "0";
  });

  it("passes a command under the root with a task-branch warning", async () => {
    const v = await gate(makeApp([root]), { tool: "Bash", command: "git log --oneline -3", cwd: inside, branch: "feat/x" });
    expect(v.blocked).toBe(false);
    expect(v.hits.find((h) => h.rule === "task-branch")?.decision).toBe("warn");
  });

  it("still denies the same command when no root is configured", async () => {
    const v = await gate(makeApp([]), { tool: "Bash", command: "git log --oneline -3", cwd: inside, branch: "feat/x" });
    expect(v.blocked).toBe(true);
  });

  it("still denies edits under the root", async () => {
    const v = await gate(makeApp([root]), { tool: "Edit", filePath: resolve(inside, "README.md"), cwd: inside, branch: "feat/x" });
    expect(v.blocked).toBe(true);
    expect(v.hits.find((h) => h.rule === "task-branch")?.decision).toBe("deny");
  });

  it("keeps the main push denial under the root", async () => {
    const v = await gate(makeApp([root]), { tool: "Bash", command: "git push origin main", cwd: inside, branch: "main" });
    expect(v.blocked).toBe(true);
    expect(v.hits.find((h) => h.rule === "no-main-push")?.decision).toBe("deny");
  });
});
