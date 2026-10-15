import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RuleConversationsRepo } from "../db/rule-conversations-repo.js";
import { RuleRunsRepo } from "../db/rule-runs-repo.js";
import { RuleServiceEventsRepo } from "../db/rule-service-events-repo.js";
import { RuleVersionsRepo } from "../db/rule-versions-repo.js";
import { RulesRepo } from "../db/rules-repo.js";
import { applyMigrations } from "../db/schema.js";
import { MaterialSourceRegistry } from "../rules/material-registry.js";
import { buildMaterialRegistry } from "../rules/patrol-runtime.js";
import { rulesRouter } from "./rules.js";
import { PatrolLearningRepo } from "../db/patrol-learning-repo.js";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function setup(sources: MaterialSourceRegistry = buildMaterialRegistry({ tendentiaUrl: "http://127.0.0.1:1" })) {
  const db = new Database(":memory:");
  open.push(db);
  applyMigrations(db);
  const rules = new RulesRepo(db);
  const runs = new RuleRunsRepo(db);
  const versions = new RuleVersionsRepo(db);
  const app = rulesRouter({
    rules,
    versions,
    patrol: { runs, conversations: new RuleConversationsRepo(db), events: new RuleServiceEventsRepo(db), sources, learning: new PatrolLearningRepo(db) },
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { db, rules, runs, versions, call };
}

const patrolRule = {
  id: "tendentia-tech-patrol",
  trigger_type: "tick",
  tick_sec: 1800,
  cooldown_sec: 1800,
  target: "chitchat",
  instructions: "素材から一つ、短い感想と出典を添える。",
  config_version: 2,
  action_config: { kind: "material-chat", source_ids: ["tendentia-public-trends"], scope_key: "hq", filters: { genres: ["tech"] } },
};

describe("/v1/rules patrol rules (CC-PATROL-05/08)", () => {
  it("creates a v2 rule disabled by default with revision 1 and a version record", async () => {
    const { call } = setup();
    const r = await call("PUT", "/", patrolRule);
    expect(r.status).toBe(200);
    expect(r.body.rule).toMatchObject({ enabled: false, config_version: 2, revision: 1, execution_mode: "patrol" });
    expect(r.body.rule.readiness).toEqual({ runnable: false, reason: "disabled" });
    const v = await call("GET", "/tendentia-tech-patrol/versions");
    expect(v.body.versions).toHaveLength(1);
  });

  it("rejects unregistered sources, unknown scopes and unverified sources", async () => {
    const { call } = setup();
    for (const action_config of [
      { ...patrolRule.action_config, source_ids: ["http://evil.example"] },
      { ...patrolRule.action_config, scope_key: "everyone" },
      { ...patrolRule.action_config, source_ids: ["corpus-activity"] },
    ]) {
      const r = await call("PUT", "/", { ...patrolRule, action_config });
      expect(r.status).toBe(422);
    }
  });

  it("requires expected_revision on PATCH and returns 409 on conflict", async () => {
    const { call } = setup();
    await call("PUT", "/", patrolRule);
    expect((await call("PATCH", "/tendentia-tech-patrol", { tick_sec: 3600 })).status).toBe(428);
    expect((await call("PATCH", "/tendentia-tech-patrol", { expected_revision: 5, tick_sec: 3600 })).status).toBe(409);
    const ok = await call("PATCH", "/tendentia-tech-patrol", { expected_revision: 1, tick_sec: 3600 });
    expect(ok.body.rule).toMatchObject({ revision: 2, tick_sec: 3600 });
  });

  it("validates the merged result on PATCH so edits cannot bypass review", async () => {
    const { call } = setup();
    await call("PUT", "/", patrolRule);
    const bad = await call("PATCH", "/tendentia-tech-patrol", { expected_revision: 1, action_config: { ...patrolRule.action_config, source_ids: [] } });
    expect(bad.status).toBe(422);
    const forbidden = await call("PATCH", "/tendentia-tech-patrol", { expected_revision: 1, instructions: "進捗確認して" });
    expect(forbidden.status).toBe(422);
  });

  it("re-validates on enable and cancels unsent runs on disable", async () => {
    const { call, runs, rules } = setup();
    await call("PUT", "/", patrolRule);
    const on = await call("POST", "/tendentia-tech-patrol/toggle");
    expect(on.body.rule).toMatchObject({ enabled: true, revision: 2 });
    runs.claim({
      run_id: "r1", rule_id: "tendentia-tech-patrol", rule_revision: 2, trigger_key: "t", action_kind: "pick",
      conversation_id: null, scope_key: "hq", channel: "chitchat", lease_owner: "o", lease_until: 9e9, now: 1,
    });
    const off = await call("POST", "/tendentia-tech-patrol/toggle");
    expect(off.body.rule.enabled).toBe(false);
    expect(runs.find("r1")).toMatchObject({ status: "skipped", reason: "rule disabled" });
    // 登録が壊れた rule は有効化できない。
    rules.updateWithRevision("tendentia-tech-patrol", 3, { action_config: "{broken" });
    expect((await call("POST", "/tendentia-tech-patrol/toggle")).status).toBe(422);
  });

  it("rolls back the definition as a new revision without changing enabled", async () => {
    const { call } = setup();
    await call("PUT", "/", patrolRule);
    await call("PATCH", "/tendentia-tech-patrol", { expected_revision: 1, tick_sec: 3600 });
    expect((await call("POST", "/tendentia-tech-patrol/rollback", { expected_revision: 1, to_revision: 1 })).status).toBe(409);
    const r = await call("POST", "/tendentia-tech-patrol/rollback", { expected_revision: 2, to_revision: 1 });
    expect(r.body.rule).toMatchObject({ revision: 3, tick_sec: 1800, enabled: false });
    const v = await call("GET", "/tendentia-tech-patrol/versions");
    expect(v.body.versions.map((x: { revision: number }) => x.revision)).toEqual([3, 2, 1]);
  });

  it("keeps legacy rules as legacy-observe and still accepts v1 PATCH without a revision", async () => {
    const { call } = setup();
    const r = await call("PUT", "/", { id: "old-rule", trigger_type: "tick", tick_sec: 300, instructions: "司会の一言" });
    expect(r.body.rule).toMatchObject({ enabled: true, config_version: 1, execution_mode: "legacy-observe" });
    expect(r.body.rule.readiness.reason).toMatch(/legacy-observe/);
    const p = await call("PATCH", "/old-rule", { tick_sec: 600 });
    expect(p.body.rule).toMatchObject({ tick_sec: 600, revision: 2 });
  });
});

describe("/v1/rules/:id/learning", () => {
  it("lists learning runs and fragments with parsed JSON", async () => {
    const { db, call } = setup();
    await call("PUT", "/", patrolRule);
    const repo = new PatrolLearningRepo(db);
    repo.insertFragment({ rule_id: patrolRule.id, kind: "message", source_key: "msg:1", status: "ok", signal: { genres: ["game"], sentiment: "positive", request: null, tone: null }, now: 1 });
    repo.recordRun({ run_id: "l1", rule_id: patrolRule.id, day: "2026-10-16", status: "applied", fragment_count: 3, proposal: JSON.stringify({ summary: "s" }), applied: JSON.stringify({ prefer_genres: ["game"] }), reason: "s", revision: 2, now: 2 });
    const r = await call("GET", `/${patrolRule.id}/learning`);
    expect(r.status).toBe(200);
    expect(r.body.runs[0]).toMatchObject({ status: "applied", applied: { prefer_genres: ["game"] } });
    expect(r.body.fragments[0].signal).toMatchObject({ genres: ["game"] });
    expect((await call("GET", "/nope/learning")).status).toBe(404);
  });
});

describe("/v1/rules patrol read routes", () => {
  it("lists sources with ready/unavailable", async () => {
    const { call } = setup(buildMaterialRegistry({ tendentiaUrl: null }));
    const r = await call("GET", "/sources");
    expect(r.body.sources.map((s: { sourceId: string; status: string; reason: string }) => [s.sourceId, s.status, s.reason])).toEqual([
      ["tendentia-public-trends", "unavailable", "not-configured"],
      ["corpus-activity", "unavailable", "contract-unverified"],
    ]);
  });

  it("previews without side effects and reports source errors", async () => {
    const { call, runs } = setup(buildMaterialRegistry({ tendentiaUrl: null }));
    const r = await call("POST", "/preview", { action_config: patrolRule.action_config, seed: 1 });
    expect(r.body.preview).toMatchObject({ ok: false, reason: "source error", seed: 1 });
    expect(r.body.preview.sourceErrors[0]).toMatchObject({ code: "not-configured" });
    expect(runs.list({}).runs).toHaveLength(0);
  });

  it("accepts a service event once and rejects unknown scopes", async () => {
    const { call } = setup();
    const ev = { source_event_id: "mm:1", service_code: "Mm", event_kind: "release", title: "Memoria 1.2", scope_key: "hq" };
    expect((await call("POST", "/service-events", ev)).body).toMatchObject({ accepted: true, duplicate: false });
    expect((await call("POST", "/service-events", ev)).body).toMatchObject({ accepted: false, duplicate: true });
    expect((await call("POST", "/service-events", { ...ev, source_event_id: "mm:2", scope_key: "personal" })).status).toBe(422);
  });

  it("pages runs and validates the status filter; log limit is clamped", async () => {
    const { call, runs } = setup();
    for (let i = 0; i < 3; i++) {
      runs.recordSkip({ run_id: `r${i}`, rule_id: "x", rule_revision: 1, trigger_key: `t${i}`, action_kind: "pick", conversation_id: null, scope_key: "hq", channel: "chitchat", now: i + 1, reason: "no material" });
    }
    const page = await call("GET", "/runs?rule_id=x&limit=2");
    expect(page.body.runs).toHaveLength(2);
    const next = await call("GET", `/runs?rule_id=x&limit=2&cursor=${encodeURIComponent(page.body.next_cursor)}`);
    expect(next.body.runs.map((r: { run_id: string }) => r.run_id)).toEqual(["r0"]);
    expect((await call("GET", "/runs?status=bogus")).status).toBe(400);
    expect((await call("GET", "/runs/r1")).body.run).toMatchObject({ status: "skipped", reason: "no material" });
    expect((await call("GET", "/log?limit=100000")).status).toBe(200);
  });
});
