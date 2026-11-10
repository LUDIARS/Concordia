/**
 * ゲート deny → リポ担当への受け渡しの案内 (spec/feature/session-auto-succession.md §3.1 02a, §3.3, INV-6)。
 * route → 決定的ゲート → 案内の差し込み → 応答を、 実 DB (in-memory) と fake の担当サービスで通す。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { HarnessAuditRepo } from "../db/harness-audit-repo.js";
import { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import { seedHarnessRules } from "../subsidiary/harness-seed.js";
import { harnessSessionRouter, type RepoAgentGateInput } from "./harness-session.js";

const GUIDANCE = "Cc がこの checkout の担当エージェントを立てます。\n```repo-brief\n{}\n```";

function makeApp(guidance: (input: RepoAgentGateInput) => string | null) {
  const db = makeTestDb();
  const rules = new HarnessRulesRepo(db);
  seedHarnessRules(rules);
  const app = new Hono();
  app.route("/v1/harness", harnessSessionRouter({
    audit: new HarnessAuditRepo(db),
    rules,
    // cwd と作業先のずれ (task-branch) で deny させる。
    taskBranches: { gate: async () => ({ rule: "task-branch", decision: "deny", reason: "起動 cwd と違うリポです。" }) } as never,
    repoAgentGuidance: guidance,
  }));
  return app;
}

const gate = (app: Hono, action: Record<string, unknown>) =>
  app.request("/v1/harness/gate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, session_id: "parent" }),
  });

describe("/v1/harness/gate — リポ担当への受け渡し", () => {
  beforeEach(() => {
    process.env.CONCORDIA_PROMPT_ANALYZER = "off";
    process.env.CONCORDIA_PROMPT_RESEARCH = "0";
  });

  it("cwd と作業先のずれの deny に依頼文の書き方を載せる (deny のまま)", async () => {
    const seen: RepoAgentGateInput[] = [];
    const app = makeApp((input) => { seen.push(input); return GUIDANCE; });
    const res = await gate(app, { tool: "Edit", cwd: "E:/Document/Ars", filePath: "E:/Document/Ars/Concordia/.wt-x/a.ts", branch: "main" });
    const body = await res.json() as { decision: string; reason: string; hits: Array<{ rule: string; suggestion?: string }> };
    expect(body.decision).toBe("deny");
    expect(body.reason).toContain(GUIDANCE);
    expect(body.hits.find((hit) => hit.rule === "task-branch")?.suggestion).toBe(GUIDANCE);
    expect(seen[0]).toMatchObject({ sessionId: "parent", cwd: "E:/Document/Ars", filePath: "E:/Document/Ars/Concordia/.wt-x/a.ts" });
  });

  it("案内が無い (対象外) なら応答は従来どおり", async () => {
    const app = makeApp(() => null);
    const body = await (await gate(app, { tool: "Edit", cwd: "E:/Document/Ars", filePath: "E:/x.ts" })).json() as { reason: string };
    expect(body.reason).not.toContain("repo-brief");
  });

  it("案内の失敗でゲートの判定を変えない", async () => {
    const app = makeApp(() => { throw new Error("boom"); });
    const body = await (await gate(app, { tool: "Edit", cwd: "E:/Document/Ars", filePath: "E:/x.ts" })).json() as { decision: string };
    expect(body.decision).toBe("deny");
  });
});
