/**
 * /v1/harness ルータの実経路裏取り。 route → 決定的ゲート → 監査記録 → 応答 を
 * 実 DB (in-memory) で通す。 フルサーバ spawn を避けつつ end-to-end を検証する。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { HarnessAuditRepo } from "../db/harness-audit-repo.js";
import { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import { createHarnessBlackbox } from "../harness/blackbox-engine.js";
import { seedHarnessRules } from "../subsidiary/harness-seed.js";
import { harnessSessionRouter } from "./harness-session.js";

import type { RunClaudeFn } from "../rules/claude-runner.js";

function makeApp(runClaude?: RunClaudeFn) {
  const db = makeTestDb();
  const audit = new HarnessAuditRepo(db);
  const rules = new HarnessRulesRepo(db);
  const blackbox = createHarnessBlackbox(db);
  seedHarnessRules(rules);
  const app = new Hono();
  app.route("/v1/harness", harnessSessionRouter({ audit, rules, runClaude, blackbox }));
  return { app, audit, rules, blackbox };
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// Hono の res.json() は unknown を返すため、 ルータ応答を緩く読むテスト用ヘルパ (cost-feed.test と同流儀)。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = async (res: { json: () => Promise<unknown> }): Promise<Record<string, any>> =>
  (await res.json()) as Record<string, any>;

describe("/v1/harness route", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    process.env.CONCORDIA_PROMPT_ANALYZER = "off";
    process.env.CONCORDIA_PROMPT_RESEARCH = "0";
    ctx = makeApp();
  });

  it("health は ok", async () => {
    const res = await ctx.app.request("/v1/harness/health");
    expect(res.status).toBe(200);
    expect((await readJson(res)).ok).toBe(true);
  });

  it("main 直 push を deny し block イベントを監査記録する", async () => {
    const res = await post(ctx.app, "/v1/harness/gate", {
      action: { tool: "Bash", command: "git push", branch: "main" },
      session_id: "sess-1",
    });
    const v = await readJson(res);
    expect(v.decision).toBe("deny");
    expect(v.blocked).toBe(true);
    expect(v.audit_ok).toBe(true);
    expect(v.blackbox.enabled).toBe(true);
    expect(v.blackbox.domain).toBe("concordia.harness.gate");
    expect(v.blackbox.decision_id).toBeGreaterThan(0);

    const audit = ctx.audit.recent({ session_id: "sess-1" });
    expect(audit).toHaveLength(1);
    expect(audit[0].event).toBe("block");
    expect(audit[0].rule).toBe("no-main-push");
    expect(ctx.blackbox.snapshot("concordia.harness.gate").stats.window).toBe(1);
  });

  it("違反なし操作は allow し gate イベントを記録する", async () => {
    const res = await post(ctx.app, "/v1/harness/gate", {
      action: { tool: "Bash", command: "git status", branch: "feat/x" },
      session_id: "sess-2",
    });
    const v = await readJson(res);
    expect(v.decision).toBe("allow");
    expect(v.blocked).toBe(false);
    const audit = ctx.audit.recent({ session_id: "sess-2" });
    expect(audit[0].event).toBe("gate");
    expect(audit[0].decision).toBe("allow");
  });

  it("context は有効ハーネスルールを返し inject を記録する", async () => {
    const res = await post(ctx.app, "/v1/harness/context", { task: "実装する", session_id: "sess-3" });
    const body = await readJson(res);
    expect(Array.isArray(body.rules)).toBe(true);
    expect(body.rules.length).toBeGreaterThan(0); // seed 済み builtin
    const languagePolicy = body.rules.find((rule: { description: string }) => rule.description.includes("Discord/Slack"));
    expect(languagePolicy).toMatchObject({ kind: "allow" });
    expect(languagePolicy.description).toContain("PR");
    expect(body.blackbox.domain).toBe("concordia.harness.gate");
    expect(ctx.audit.recent({ event: "inject" })).toHaveLength(1);
  });

  it("audit エンドポイントで decision フィルタ + summary が取れる", async () => {
    await post(ctx.app, "/v1/harness/gate", { action: { tool: "Bash", command: "git push", branch: "main" }, session_id: "s" });
    await post(ctx.app, "/v1/harness/gate", { action: { tool: "Bash", command: "ls", branch: "feat/x" }, session_id: "s" });
    const res = await ctx.app.request("/v1/harness/audit?decision=deny");
    const body = await readJson(res);
    expect(body.audit).toHaveLength(1);
    expect(body.audit[0].decision).toBe("deny");
    const summaryDecisions = body.summary.map((s: { decision: string }) => s.decision).sort();
    expect(summaryDecisions).toContain("deny");
  });

  it("不正な body は 400", async () => {
    const res = await post(ctx.app, "/v1/harness/gate", { nope: true });
    expect(res.status).toBe(400);
  });

  it("セッション横断で 5 リポ超を編集すると max-repos warn が発火する (editedRepos 自動蓄積)", async () => {
    // hook は per-action の cwd を送るだけ。 サーバが監査ログから editedRepos を蓄積する。
    const edit = (repo: string) =>
      post(ctx.app, "/v1/harness/gate", {
        action: { tool: "Edit", filePath: `${repo}/f.ts`, cwd: repo, branch: "feat/x" },
        session_id: "multi",
      });
    // 5 リポ目までは warn 無し (上限ちょうど)。
    for (const r of ["/r/a", "/r/b", "/r/c", "/r/d", "/r/e"]) {
      const v = await readJson(await edit(r));
      expect(v.decision).toBe("allow");
    }
    // 6 リポ目で上限超過 → warn。
    const v6 = await readJson(await edit("/r/f"));
    expect(v6.decision).toBe("warn");
    expect(v6.hits.some((h: { rule: string }) => h.rule === "max-repos")).toBe(true);

    // 同じリポを再編集しても distinct は増えないので warn のまま (新規リポ起因ではない)。
    const repos = ctx.audit.distinctEditedRepos("multi");
    expect(repos).toHaveLength(6);
  });

  it("session_id 無しなら editedRepos を蓄積できず max-repos は発火しない", async () => {
    for (const r of ["/r/a", "/r/b", "/r/c", "/r/d", "/r/e", "/r/f"]) {
      const v = await readJson(await post(ctx.app, "/v1/harness/gate", {
        action: { tool: "Edit", filePath: `${r}/f.ts`, cwd: r, branch: "feat/x" },
      }));
      expect(v.decision).toBe("allow");
    }
  });

  it("intent falls back to heuristic analysis when runClaude is not wired", async () => {
    const res = await post(ctx.app, "/v1/harness/intent", { prompt: "Add a hook to Concordia", session_id: "i0" });
    const v = await readJson(res);
    expect(v.enabled).toBe(true);
    expect(v.source).toBe("heuristic");
    expect(v.search_tags).toContain("hook");
    expect(v.blackbox.domain).toBe("concordia.harness.intent");
  });

  it("intent uses runClaude when haiku analyzer mode is selected", async () => {
    process.env.CONCORDIA_PROMPT_ANALYZER = "haiku";
    const fake = makeApp(async () => ({
      ok: true,
      stdout: '{"decision":"warn","risk":"high","intent":"delete production data","concerns":["destructive_operation"],"advice":"stop"}',
      stderr: "",
    }));
    const res = await post(fake.app, "/v1/harness/intent", { prompt: "Delete the production DB", project: "concordia", session_id: "i1" });
    const v = await readJson(res);
    expect(v.enabled).toBe(true);
    expect(v.source).toBe("haiku");
    expect(v.decision).toBe("warn");
    expect(v.risk).toBe("high");
    expect(v.audit_ok).toBe(true);

    const audit = fake.audit.recent({ session_id: "i1", event: "start_prompt" });
    expect(audit).toHaveLength(1);
    expect(audit[0].decision).toBe("warn");
    expect(audit[0].hook).toBe("intent");
  });

  it("intent の不正な body は 400", async () => {
    const fake = makeApp(async () => ({ ok: true, stdout: "{}", stderr: "" }));
    const res = await post(fake.app, "/v1/harness/intent", { prompt: "" });
    expect(res.status).toBe(400);
  });
});
