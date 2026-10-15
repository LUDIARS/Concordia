import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { RuleConversationsRepo } from "../db/rule-conversations-repo.js";
import { RuleRunsRepo } from "../db/rule-runs-repo.js";
import { RuleServiceEventsRepo } from "../db/rule-service-events-repo.js";
import { RuleVersionsRepo } from "../db/rule-versions-repo.js";
import { RulesRepo } from "../db/rules-repo.js";
import { applyMigrations } from "../db/schema.js";
import { SubsidiaryPatrolDefaultsRepo } from "../db/subsidiary-patrol-defaults-repo.js";
import { parseSubsidiaryDefaults } from "../rules/patrol-config.js";
import { buildMaterialRegistry } from "../rules/patrol-runtime.js";
import { rulesRouter, serialize } from "./rules.js";
import { subsidiaryPatrolRouter } from "./subsidiary-patrol.js";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

const GLAB = "sub-glab";
const VOB = "sub-vob";
const GLAB_CHANNEL = "1546109590930853962";

function setup() {
  const db = new Database(":memory:");
  open.push(db);
  applyMigrations(db);
  const rules = new RulesRepo(db);
  const runs = new RuleRunsRepo(db);
  const versions = new RuleVersionsRepo(db);
  const defaults = new SubsidiaryPatrolDefaultsRepo(db);
  const sources = buildMaterialRegistry({ tendentiaUrl: "http://127.0.0.1:1" });
  const known: Record<string, { name: string }> = { [GLAB]: { name: "glab" }, [VOB]: { name: "pagus-vob" } };
  const inherit = (id: string) => {
    const row = defaults.get(id);
    const parsed = row ? parseSubsidiaryDefaults(row.config) : null;
    return parsed?.ok ? parsed.defaults : null;
  };
  const app = new Hono();
  app.route("/v1/rules", rulesRouter({
    rules, versions,
    patrol: { runs, conversations: new RuleConversationsRepo(db), events: new RuleServiceEventsRepo(db), sources },
    owners: { exists: (id) => id in known, defaults: inherit },
  }));
  app.route("/v1/subsidiaries", subsidiaryPatrolRouter({
    rules, versions, defaults, sources,
    subsidiary: (id) => known[id] ?? null,
    serializeRule: (r) => serialize(r, runs, sources, r.subsidiary_id ? inherit(r.subsidiary_id) : null),
    cancelInFlight: (id, reason, now) => runs.cancelInFlight(id, reason, now),
  }));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { rules, versions, call };
}

describe("subsidiary patrol defaults", () => {
  it("stores defaults per subsidiary and lets rules inherit them", async () => {
    const { call } = setup();
    expect((await call("GET", `/v1/subsidiaries/${GLAB}/patrol-defaults`)).body.defaults).toEqual({});
    const put = await call("PUT", `/v1/subsidiaries/${GLAB}/patrol-defaults`, {
      actor: "discord:1", defaults: { quiet_hours: { start: "22:00", end: "09:30" }, discord_channel_id: GLAB_CHANNEL, persona_hint: "学校らしく" },
    });
    expect(put.status).toBe(200);
    expect(put.body.updated_by).toBe("discord:1");
    const created = await call("POST", `/v1/subsidiaries/${GLAB}/patrol/rules`, { actor: "discord:1" });
    expect(created.status).toBe(200);
    expect(created.body.rule).toMatchObject({ id: "glab-trend-1", enabled: true, subsidiary_id: GLAB });
    // 保存された設定には引き継ぐ項目が無く、 実行時の値は子会社の既定値で埋まる
    expect(created.body.rule.action_config.quiet_hours).toBeUndefined();
    expect(created.body.rule.effective_config).toMatchObject({
      quiet_hours: { start: "22:00", end: "09:30" }, discord_channel_id: GLAB_CHANNEL, persona_hint: "学校らしく", root_limit_per_day: 8,
    });
    expect(created.body.rule.action_config.scope_key).toBe("public");
  });

  it("rejects unknown keys and unknown subsidiaries", async () => {
    const { call } = setup();
    expect((await call("PUT", `/v1/subsidiaries/${GLAB}/patrol-defaults`, { actor: "a", defaults: { url: "x" } })).status).toBe(400);
    expect((await call("GET", "/v1/subsidiaries/nope/patrol-defaults")).status).toBe(404);
  });

  it("refuses to add a rule without a destination channel", async () => {
    const { call } = setup();
    const r = await call("POST", `/v1/subsidiaries/${VOB}/patrol/rules`, { actor: "discord:2" });
    expect(r.status).toBe(422);
    expect(r.body.reason).toMatch(/投稿先チャンネル/);
  });

  it("marks the owner paused in readiness", async () => {
    const { call } = setup();
    await call("POST", `/v1/subsidiaries/${GLAB}/patrol/rules`, { actor: "a", discord_channel_id: GLAB_CHANNEL });
    await call("PUT", `/v1/subsidiaries/${GLAB}/patrol-defaults`, { actor: "a", defaults: { paused: true } });
    const list = await call("GET", `/v1/subsidiaries/${GLAB}/patrol/rules`);
    expect(list.body.rules[0].readiness).toEqual({ runnable: false, reason: "owner subsidiary paused" });
  });
});

describe("subsidiary patrol rules (ownership)", () => {
  it("edits only the fields a subsidiary may change and records the actor", async () => {
    const { call, versions } = setup();
    await call("POST", `/v1/subsidiaries/${GLAB}/patrol/rules`, { actor: "discord:1", discord_channel_id: GLAB_CHANNEL });
    const patched = await call("PATCH", `/v1/subsidiaries/${GLAB}/patrol/rules/glab-trend-1`, {
      actor: "discord:9", tick_sec: 3600, root_limit_per_day: 3, quiet_hours: null, persona_hint: "部活っぽく",
    });
    expect(patched.status).toBe(200);
    expect(patched.body.rule).toMatchObject({ tick_sec: 3600, revision: 2 });
    expect(patched.body.rule.effective_config).toMatchObject({ root_limit_per_day: 3, quiet_hours: null, persona_hint: "部活っぽく" });
    expect(versions.list("glab-trend-1").map((v) => v.actor)).toContain("discord:9");
    // scope や素材元は変えられない
    const bad = await call("PATCH", `/v1/subsidiaries/${GLAB}/patrol/rules/glab-trend-1`, { actor: "x", scope_key: "hq" });
    expect(bad.status).toBe(400);
    // 既定値に戻す
    const back = await call("PATCH", `/v1/subsidiaries/${GLAB}/patrol/rules/glab-trend-1`, { actor: "x", quiet_hours: "inherit", root_limit_per_day: null });
    expect(back.body.rule.action_config.quiet_hours).toBeUndefined();
    expect(back.body.rule.action_config.root_limit_per_day).toBeUndefined();
  });

  it("does not let one subsidiary see or change another's or head-office rules", async () => {
    const { call } = setup();
    await call("POST", `/v1/subsidiaries/${GLAB}/patrol/rules`, { actor: "a", discord_channel_id: GLAB_CHANNEL });
    expect((await call("GET", `/v1/subsidiaries/${VOB}/patrol/rules`)).body.rules).toHaveLength(0);
    expect((await call("PATCH", `/v1/subsidiaries/${VOB}/patrol/rules/glab-trend-1`, { actor: "b", tick_sec: 600 })).status).toBe(404);
    expect((await call("POST", `/v1/subsidiaries/${VOB}/patrol/rules/glab-trend-1/toggle`, { actor: "b", enabled: false })).status).toBe(404);
    await call("PUT", "/v1/rules", {
      id: "hq-rule", trigger_type: "tick", tick_sec: 1800, cooldown_sec: 1800, target: "chitchat", instructions: "x",
      config_version: 2, action_config: { kind: "material-chat", source_ids: ["tendentia-public-trends"], scope_key: "hq" },
    });
    expect((await call("POST", `/v1/subsidiaries/${GLAB}/patrol/rules/hq-rule/toggle`, { actor: "b", enabled: true })).status).toBe(404);
  });

  it("toggles off and on", async () => {
    const { call } = setup();
    await call("POST", `/v1/subsidiaries/${GLAB}/patrol/rules`, { actor: "a", discord_channel_id: GLAB_CHANNEL });
    const off = await call("POST", `/v1/subsidiaries/${GLAB}/patrol/rules/glab-trend-1/toggle`, { actor: "a", enabled: false });
    expect(off.body.rule.enabled).toBe(false);
    const on = await call("POST", `/v1/subsidiaries/${GLAB}/patrol/rules/glab-trend-1/toggle`, { actor: "a", enabled: true });
    expect(on.body.rule.enabled).toBe(true);
  });
});

describe("/v1/rules ownership", () => {
  const base = {
    trigger_type: "tick", tick_sec: 1800, cooldown_sec: 1800, target: "chitchat", instructions: "x", config_version: 2,
    action_config: { kind: "material-chat", source_ids: ["tendentia-public-trends"], scope_key: "public" },
  };

  it("filters by owner and validates the subsidiary", async () => {
    const { call } = setup();
    expect((await call("PUT", "/v1/rules", { ...base, id: "a", subsidiary_id: GLAB })).status).toBe(200);
    expect((await call("PUT", "/v1/rules", { ...base, id: "b" })).status).toBe(200);
    expect((await call("PUT", "/v1/rules", { ...base, id: "c", subsidiary_id: "nope" })).status).toBe(400);
    const glab = await call("GET", `/v1/rules?subsidiary_id=${GLAB}`);
    expect(glab.body.rules.map((r: any) => r.id)).toEqual(["a"]);
    const hq = await call("GET", "/v1/rules?head_office=1");
    expect(hq.body.rules.map((r: any) => r.id)).toContain("b");
    expect(hq.body.rules.map((r: any) => r.id)).not.toContain("a");
    expect((await call("GET", `/v1/rules?subsidiary_id=${GLAB}&head_office=1`)).status).toBe(400);
  });

  it("requires public scope for subsidiary rules", async () => {
    const { call } = setup();
    const r = await call("PUT", "/v1/rules", {
      ...base, id: "d", subsidiary_id: GLAB, action_config: { ...base.action_config, scope_key: "hq" },
    });
    expect(r.status).toBe(422);
    expect(r.body.reason).toMatch(/子会社/);
  });
});
