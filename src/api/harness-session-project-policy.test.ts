/**
 * project_codes の必須設定 (contract / ddd) が gate と supply に与える効果の実経路裏取り。
 * spec/feature/project-harness-policy.md: 未選択プロジェクトへ追加要件を強制しない。
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { HarnessAuditRepo } from "../db/harness-audit-repo.js";
import { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import { harnessSessionRouter } from "./harness-session.js";
import type { ProjectHarnessPolicy } from "../harness/project-policy.js";

function makeApp(policy: ProjectHarnessPolicy) {
  const db = makeTestDb();
  const app = new Hono();
  app.route("/v1/harness", harnessSessionRouter({
    audit: new HarnessAuditRepo(db), rules: new HarnessRulesRepo(db),
    projectPolicy: async () => policy,
    sessionContext: () => ({ teamId: null, contractComplete: false, projectPolicy: policy }),
  }));
  return app;
}
const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const readJson = async (res: { json: () => Promise<unknown> }) => (await res.json()) as Record<string, any>;
const edit = { tool: "Edit", filePath: "E:/repo/src/example.ts", cwd: "E:/repo", branch: "feat/x" };

describe("project policy opt-in", () => {
  it("契約未確定でも contract 未選択プロジェクトのコード編集は deny しない", async () => {
    const body = await readJson(await post(makeApp({ ddd: false, contract: false }), "/v1/harness/gate", { action: edit, session_id: "s-1" }));
    expect(body.hits.map((h: { rule: string }) => h.rule)).not.toContain("contract-incomplete");
    expect(body.decision).not.toBe("deny");
  });

  it("contract 選択プロジェクトでは契約未確定のコード編集を deny する", async () => {
    const body = await readJson(await post(makeApp({ ddd: false, contract: true }), "/v1/harness/gate", { action: edit, session_id: "s-1" }));
    expect(body.hits.map((h: { rule: string }) => h.rule)).toContain("contract-incomplete");
    expect(body.decision).toBe("deny");
  });

  it("必須設定が有効なら supply に手順ルールが載る", async () => {
    const on = await readJson(await post(makeApp({ ddd: true, contract: true, testsRequired: true }), "/v1/harness/context", { task: "実装する", session_id: "s-1" }));
    const guidance = on.rules.find((r: { title: string }) => r.title === "DDD/契約プロセス");
    expect(guidance?.kind).toBe("block");
    expect(guidance?.description).toContain("1. 価値:");
    expect(guidance?.description).toContain("契約:");
    expect(guidance?.description).toContain("cc.acceptance.json");
    const off = await readJson(await post(makeApp({ ddd: false, contract: false }), "/v1/harness/context", { task: "実装する", session_id: "s-1" }));
    expect(off.rules.some((r: { title: string }) => r.title === "DDD/契約プロセス")).toBe(false);
  });
});
