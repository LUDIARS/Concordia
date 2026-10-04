import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { BountyReportersRepo } from "./bounty-reporters-repo.js";

const neco = { subsidiary_id: null, platform: "discord", platform_user_id: "905235114026467350" };

describe("BountyReportersRepo", () => {
  it("keeps one row per company, platform and user", () => {
    const repo = new BountyReportersRepo(makeTestDb());
    const first = repo.findOrCreate(neco, 10);
    expect(first.id).toMatch(/^bp_[0-9a-f]{32}$/);
    expect(first).toMatchObject({ subsidiary_id: null, public_name: null, created_at: 10 });
    expect(repo.findOrCreate(neco, 20).id).toBe(first.id);
    expect(repo.find(first.id)?.updated_at).toBe(10);
  });

  it("separates the same user across companies, including the head office (NULL)", () => {
    const db = makeTestDb();
    const repo = new BountyReportersRepo(db);
    const headOffice = repo.findOrCreate(neco, 10);
    const subsidiary = repo.findOrCreate({ ...neco, subsidiary_id: "sub_a" }, 10);
    expect(subsidiary.id).not.toBe(headOffice.id);
    expect(repo.findByKey({ ...neco, subsidiary_id: "sub_a" })?.id).toBe(subsidiary.id);
    // 本社 (NULL) 同士も 1 行に閉じる (NULL は UNIQUE で別扱いになるので式 index で持つ)。
    expect(() => db.prepare(`
      INSERT INTO bounty_reporters(id, subsidiary_id, platform, platform_user_id, public_name, created_at, updated_at)
      VALUES ('bp_dup', NULL, 'discord', ?, NULL, 1, 1)
    `).run(neco.platform_user_id)).toThrow(/UNIQUE/);
  });

  it("changes the public name and returns it to anonymous", () => {
    const repo = new BountyReportersRepo(makeTestDb());
    const named = repo.setPublicName(neco, "neco", 30);
    expect(named).toMatchObject({ public_name: "neco", updated_at: 30 });
    expect(repo.findOrCreate(neco, 40).public_name).toBe("neco");
    expect(repo.setPublicName(neco, null, 50).public_name).toBeNull();
    expect(repo.findByKey({ ...neco, platform_user_id: "111111" })).toBeNull();
  });
});
