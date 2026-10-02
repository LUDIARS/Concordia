/**
 * 月次予算の途中停止 (spec/feature/usage-budgets.md §5.2): ハーネスの gate が予算の判定で deny すること。
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { HarnessAuditRepo } from "../db/harness-audit-repo.js";
import { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import { harnessSessionRouter, type HarnessSessionApiDeps } from "./harness-session.js";

function makeApp(budgetGate?: HarnessSessionApiDeps["budgetGate"]) {
  const db = makeTestDb();
  const app = new Hono();
  app.route("/v1/harness", harnessSessionRouter({
    audit: new HarnessAuditRepo(db), rules: new HarnessRulesRepo(db),
    ...(budgetGate ? { budgetGate } : {}),
  }));
  return app;
}
const gate = (app: Hono, sessionId?: string) => app.request("/v1/harness/gate", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: { tool: "Bash", command: "ls", cwd: "E:/repo", branch: "feat/x" }, ...(sessionId ? { session_id: sessionId } : {}) }),
});

describe("harness gate — usage budget", () => {
  it("予算を使い切ったセッションのツールを理由つきで止める", async () => {
    const budgetGate = vi.fn(async () => ({ deny: true as const, reason: "予算を使い切ったので作業を止めます。予算が戻ったら再開できます。" }));
    const body = await (await gate(makeApp(budgetGate), "s-1")).json() as Record<string, any>;
    expect(budgetGate).toHaveBeenCalledWith("s-1");
    expect(body.decision).toBe("deny");
    expect(body.hits.map((h: { rule: string }) => h.rule)).toContain("usage-budget");
    expect(body.reason).toContain("予算を使い切った");
  });

  it("残りがある・判定に失敗した・session が無い場合は予算で止めない", async () => {
    const allow = await (await gate(makeApp(async () => ({ deny: false })), "s-1")).json() as Record<string, any>;
    expect(allow.decision).not.toBe("deny");
    const failing = await (await gate(makeApp(async () => { throw new Error("log read failed"); }), "s-1")).json() as Record<string, any>;
    expect(failing.decision).not.toBe("deny");
    const budgetGate = vi.fn(async () => ({ deny: true as const, reason: "x" }));
    await gate(makeApp(budgetGate));
    expect(budgetGate).not.toHaveBeenCalled();
  });
});
