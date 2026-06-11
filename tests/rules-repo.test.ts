import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { RulesRepo, seedDefaultRules } from "../src/db/rules-repo.js";

function fresh() {
  const db = makeTestDb();
  return new RulesRepo(db);
}

describe("RulesRepo + seedDefaultRules", () => {
  let r: RulesRepo;
  beforeEach(() => { r = fresh(); });

  it("seeds default-tick once with 5-min interval", () => {
    seedDefaultRules(r);
    seedDefaultRules(r); // 二回目は no-op
    const list = r.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("default-tick");
    expect(list[0].trigger_type).toBe("tick");
    expect(list[0].tick_sec).toBe(300);
    expect(list[0].cooldown_sec).toBe(300);
    expect(list[0].enabled).toBe(1);
  });

  it("re-seeds (UPDATE) default-tick instructions when system rule is stale", () => {
    seedDefaultRules(r);
    // 古い instructions / cooldown を直接 DB に書き込んで drift を再現
    const db = (r as any).db as import("better-sqlite3").Database;
    db.prepare(
      `UPDATE rules SET instructions = ?, cooldown_sec = ?, description = ? WHERE id = ?`,
    ).run("OLD instructions", 60, "OLD description", "default-tick");

    seedDefaultRules(r); // 二度目の seed で drift 検知 → UPDATE
    const after = r.find("default-tick");
    expect(after?.instructions).not.toBe("OLD instructions");
    expect(after?.instructions).toMatch(/チャットの発言フック用/);
    expect(after?.cooldown_sec).toBe(300);
    expect(after?.description).toMatch(/default 5-min tick/);
  });

  it("does not overwrite default-tick if a human/ai changed added_by", () => {
    seedDefaultRules(r);
    const db = (r as any).db as import("better-sqlite3").Database;
    db.prepare(
      `UPDATE rules SET added_by = 'human', instructions = ? WHERE id = ?`,
    ).run("HUMAN-EDITED", "default-tick");
    seedDefaultRules(r);
    expect(r.find("default-tick")?.instructions).toBe("HUMAN-EDITED");
  });

  it("retires legacy default-5sec-tick when seeding", () => {
    // 過去の状態を再現
    r.insert({
      id: "default-5sec-tick",
      description: "legacy",
      trigger_type: "tick",
      tick_sec: 5,
      event_kind: null,
      conditions: "[]",
      instructions: "...",
      target: null,
      cooldown_sec: 5,
      added_by: "system",
    });
    seedDefaultRules(r);
    const old = r.find("default-5sec-tick");
    expect(old?.enabled).toBe(0);
    expect(old?.removed_reason).toMatch(/replaced by default-tick/);
    const fresh = r.find("default-tick");
    expect(fresh?.tick_sec).toBe(300);
  });

  it("insert + find + toggle", () => {
    r.insert({
      id: "foo", description: "bar",
      trigger_type: "event", tick_sec: null, event_kind: "edit",
      conditions: "[]", instructions: "do something",
      target: "chitchat", cooldown_sec: 30, added_by: "human",
    });
    expect(r.find("foo")?.enabled).toBe(1);
    r.toggle("foo", false);
    expect(r.find("foo")?.enabled).toBe(0);
  });

  it("setLastFired updates timestamp", () => {
    r.insert({
      id: "x", description: null, trigger_type: "tick", tick_sec: 5,
      event_kind: null, conditions: "[]", instructions: "...", target: null,
      cooldown_sec: 5, added_by: "system",
    });
    r.setLastFired("x", 12345);
    expect(r.find("x")?.last_fired_at).toBe(12345);
  });

  it("remove sets removed_at + reason", () => {
    r.insert({
      id: "y", description: null, trigger_type: "tick", tick_sec: 5,
      event_kind: null, conditions: "[]", instructions: "...", target: null,
      cooldown_sec: 5, added_by: "ai",
    });
    expect(r.remove("y", "ai", "no longer needed")).toBe(true);
    const after = r.find("y");
    expect(after?.enabled).toBe(0);
    expect(after?.removed_reason).toBe("no longer needed");
    expect(after?.removed_by).toBe("ai");
  });

  it("log + recentLogs", () => {
    r.log({ rule_id: "x", action: "fire", actor: "ai", detail: "posted" });
    r.log({ rule_id: "x", action: "skip", actor: "engine", detail: "cooldown" });
    const logs = r.recentLogs(10);
    expect(logs).toHaveLength(2);
    const actions = logs.map((l) => l.action).sort();
    expect(actions).toEqual(["fire", "skip"]);
  });

  it("default-tick instructions include the five rule guards", () => {
    seedDefaultRules(r);
    const inst = r.find("default-tick")?.instructions ?? "";
    // 禁則 (無音 / 進捗 ping / 汎用雑談 / 衝突回避先行 / stat 取りこぼし) が織り込まれている
    expect(inst).toMatch(/無音/);
    expect(inst).toMatch(/進捗 ping|進捗\?|進捗どう/);
    expect(inst).toMatch(/汎用雑談|persona の役割/);
    expect(inst).toMatch(/conflicts\?repo=|衝突回避が会話より先/);
    expect(inst).toMatch(/取りこぼし|stat (poll|取りこぼし)/);
  });
});
