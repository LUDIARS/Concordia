/**
 * 本社内窓口 (mode='desk') — 子会社と同じゲートを通しつつ、 専用 Bot は起動しない。
 * spec/feature/subsidiary-delegation.md §9。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SubsidiaryRepo } from "../db/subsidiary-repo.js";
import { SubsidiaryBotManager } from "./manager.js";

function makeManager(repo: SubsidiaryRepo, started: string[]) {
  return new SubsidiaryBotManager({
    subsidiaryRepo: repo,
    harnessRepo: {} as never,
    delegationRepo: {} as never,
    delegationService: {} as never,
    headOfficeDiscord: () => ({
      enabled: true,
      token: "t",
      guildId: "hq",
      applicationId: "app",
      permissionRequestsEnabled: false,
      messageOptimizationEnabled: false,
    }),
    runClaude: (() => {}) as never,
    budgetTracker: {} as never,
    baseDiscordDeps: () => ({}),
    startBot: async (deps) => {
      started.push((deps as { subsidiary: { id: string } }).subsidiary.id);
      return { stop: async () => {} };
    },
  });
}

describe("subsidiary mode=desk", () => {
  let repo: SubsidiaryRepo;

  beforeEach(() => {
    repo = new SubsidiaryRepo(makeTestDb());
  });

  it("既定の mode は subsidiary (既存行の互換)", () => {
    const row = repo.create({ name: "acme", enabled: true, guild_id: "g1" });
    expect(row.mode).toBe("subsidiary");
  });

  it("desk は Bot 一覧に出ず、 desk 一覧に出る", () => {
    repo.create({ name: "acme", enabled: true, guild_id: "g1" });
    repo.create({ name: "intake", mode: "desk", enabled: true });
    // 無効な desk は配線対象外。
    repo.create({ name: "off", mode: "desk", enabled: false });

    expect(repo.listEnabledBots().map((r) => r.name)).toEqual(["acme"]);
    expect(repo.listEnabledDesks().map((r) => r.name)).toEqual(["intake"]);
  });

  it("desk の Bot 起動要求は no_bot を返す (無言で成功扱いにしない)", async () => {
    const started: string[] = [];
    const manager = makeManager(repo, started);
    const desk = repo.create({ name: "intake", mode: "desk", enabled: true });

    const r = await manager.start(desk.id);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("no_bot");
    expect(started).toEqual([]);
    expect(manager.isRunning(desk.id)).toBe(false);
  });

  it("startAll は子会社だけ起動し desk は飛ばす", async () => {
    const started: string[] = [];
    const manager = makeManager(repo, started);
    const sub = repo.create({ name: "acme", enabled: true, guild_id: "g1" });
    repo.create({ name: "intake", mode: "desk", enabled: true });

    await manager.startAll();
    expect(started).toEqual([sub.id]);
  });

  it("mode は PATCH で切り替えられる (子会社 → 本社内窓口)", () => {
    const row = repo.create({ name: "acme", enabled: true, guild_id: "g1" });
    const updated = repo.update(row.id, { mode: "desk" });
    expect(updated!.mode).toBe("desk");
    expect(repo.listEnabledBots()).toEqual([]);
    expect(repo.listEnabledDesks().map((r) => r.id)).toEqual([row.id]);
  });
});
