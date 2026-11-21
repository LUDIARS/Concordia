/**
 * /v1/harness/context の blackbox 欄が stats 専用経路で組まれることの裏取り (FS-11 P0-b)。
 * 応答の形 (blackbox = DomainStats) は変えず、 snapshot (listPending / listRules) を経由しない。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { HarnessAuditRepo } from "../db/harness-audit-repo.js";
import { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import { createHarnessBlackbox, HARNESS_BLACKBOX_DOMAINS } from "../harness/blackbox-engine.js";
import { seedHarnessRules } from "../subsidiary/harness-seed.js";
import { harnessSessionRouter } from "./harness-session.js";

function makeApp() {
  const db = makeTestDb();
  const audit = new HarnessAuditRepo(db);
  const rules = new HarnessRulesRepo(db);
  const blackbox = createHarnessBlackbox(db);
  seedHarnessRules(rules);
  const app = new Hono();
  app.route("/v1/harness", harnessSessionRouter({ audit, rules, blackbox }));
  return { app, blackbox };
}

beforeEach(() => {
  process.env.CONCORDIA_PROMPT_ANALYZER = "off";
  process.env.CONCORDIA_PROMPT_RESEARCH = "0";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/v1/harness/context の blackbox stats", () => {
  it("snapshot を呼ばずに stats(gate, 25) をそのまま返す", async () => {
    const { app, blackbox } = makeApp();
    const snapshotSpy = vi.spyOn(blackbox, "snapshot");
    const statsSpy = vi.spyOn(blackbox, "stats");
    const res = await app.request("/v1/harness/context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "実装する", session_id: "ctx-stats" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blackbox?: unknown };
    expect(snapshotSpy).not.toHaveBeenCalled();
    expect(statsSpy).toHaveBeenCalledWith(HARNESS_BLACKBOX_DOMAINS.gate, 25);
    expect(body.blackbox).toEqual(blackbox.stats(HARNESS_BLACKBOX_DOMAINS.gate, 25));
  });
});
