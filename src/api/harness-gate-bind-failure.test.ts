/** gate がリポ文脈を解けない (detached HEAD) とき、素の 5xx ではなく理由付きの deny を返す。 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { HarnessAuditRepo } from "../db/harness-audit-repo.js";
import { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import { harnessSessionRouter } from "./harness-session.js";
import { ImplementationBindFailure } from "../implementation-tools/bind-failure.js";
import { inspectImplementationRepo } from "../implementation-tools/repo-context.js";
import { bindFailureDenial } from "./harness-gate-bind-failure.js";

function makeApp(projectPolicy: (cwd: string) => Promise<never>) {
  const db = makeTestDb();
  const app = new Hono();
  app.route("/v1/harness", harnessSessionRouter({ audit: new HarnessAuditRepo(db), rules: new HarnessRulesRepo(db), projectPolicy }));
  return app;
}
const gate = (app: Hono) => app.request("/v1/harness/gate", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: { tool: "Bash", command: "git status", cwd: "E:/repo/lib/lapilli", branch: "" }, session_id: "s-1" }) });

describe("gate on a detached HEAD", () => {
  it("answers a deny naming unnamed_branch instead of a bare 5xx", async () => {
    // 実経路: inspectImplementationRepo は branch --show-current が空なら unnamed_branch を投げる。
    const detached = (cwd: string) => inspectImplementationRepo(cwd, async (_cwd, args) => args[0] === "branch" ? "" : "E:/repo/lib/lapilli")
      .then(() => { throw new Error("expected unnamed_branch"); });
    const res = await gate(makeApp(detached));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body).toMatchObject({ decision: "deny", blocked: true, error: "unnamed_branch", stage: "repository" });
    expect(body.reason).toContain("unnamed_branch");
    expect(body.reason).toMatch(/^\[cc_error\]/);
    expect(body.hits[0].rule).toBe("gate-repository-unnamed_branch");
    expect(body.local_policy).toBeUndefined();
  });

  it("still lets unknown failures surface as errors", async () => {
    const res = await gate(makeApp(async () => { throw new Error("boom"); }));
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("builds the denial from the fixed bind vocabulary", () => {
    const denial = bindFailureDenial(new ImplementationBindFailure("repository", "git_timeout"));
    expect(denial.error).toBe("git_timeout");
    expect(denial.reason).toContain("Retry the command.");
  });
});
