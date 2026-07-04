import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SubsidiaryRepo } from "../db/subsidiary-repo.js";
import { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { SubsidiaryBotManager, type BaseDiscordDeps } from "./manager.js";
import type { DiscordBotHandle } from "../discord/bot.js";
import type { DiscordEnv } from "../discord/types.js";

let db: ReturnType<typeof makeTestDb>;
let subRepo: SubsidiaryRepo;

// 子会社 Bot は本社と同じ token / application_id を使う。 既定では本社 token あり。
const HEAD_WITH_TOKEN: DiscordEnv = {
  enabled: true,
  token: "head-tok",
  guildId: "head-guild",
  applicationId: "app-1",
  permissionRequestsEnabled: false,
  messageOptimizationEnabled: true,
};

function makeManager(
  startBot: (deps: unknown) => Promise<DiscordBotHandle | null>,
  headOffice: DiscordEnv = HEAD_WITH_TOKEN,
) {
  return new SubsidiaryBotManager({
    subsidiaryRepo: subRepo,
    harnessRepo: new HarnessRulesRepo(db),
    delegationRepo: new DelegationRepo(db),
    delegationService: {} as never,
    headOfficeDiscord: () => headOffice,
    runClaude: async () => ({ ok: true, stdout: "{}", stderr: "" }),
    budgetTracker: { status: () => ({ todayTokens: 0, budget: 0, blocked: false, dateIso: "2026-06-26" }) } as never,
    baseDiscordDeps: () => ({}) as unknown as BaseDiscordDeps,
    startBot,
  });
}

beforeEach(() => {
  db = makeTestDb();
  subRepo = new SubsidiaryRepo(db);
});

describe("SubsidiaryBotManager", () => {
  it("enabled+guild 設定済み discord 子会社を start し running になる (token は本社共有)", async () => {
    const sub = subRepo.create({ name: "co", platform: "discord", enabled: true, guild_id: "g1" });
    const stop = vi.fn(async () => {});
    const startBot = vi.fn(async () => ({ stop }) as DiscordBotHandle);
    const mgr = makeManager(startBot);
    const r = await mgr.start(sub.id);
    expect(r.status).toBe("started");
    expect(mgr.isRunning(sub.id)).toBe(true);
    // 二度目は already_running (再起動しない)。
    expect((await mgr.start(sub.id)).status).toBe("already_running");
    expect(startBot).toHaveBeenCalledOnce();
    await mgr.stop(sub.id);
    expect(stop).toHaveBeenCalledOnce();
    expect(mgr.isRunning(sub.id)).toBe(false);
  });

  it("inherits head-office Discord message settings for subsidiary bots", async () => {
    const sub = subRepo.create({ name: "co-settings", platform: "discord", enabled: true, guild_id: "g1" });
    const startBot = vi.fn(async (_deps: unknown) => ({ stop: async () => {} }) as DiscordBotHandle);
    const mgr = makeManager(startBot, {
      ...HEAD_WITH_TOKEN,
      permissionRequestsEnabled: true,
      messageOptimizationEnabled: false,
    });
    await mgr.start(sub.id);
    const deps = startBot.mock.calls[0][0] as { resolveConfig?: () => DiscordEnv };
    expect(deps.resolveConfig?.()).toMatchObject({
      permissionRequestsEnabled: true,
      messageOptimizationEnabled: false,
    });
  });

  it("guild 未設定なら missing_config (本社 token はあっても guild が要る)", async () => {
    const sub = subRepo.create({ name: "co2", platform: "discord", enabled: true });
    const mgr = makeManager(async () => ({ stop: async () => {} }));
    expect((await mgr.start(sub.id)).status).toBe("missing_config");
  });

  it("本社 token 未設定なら missing_config (子会社は本社 token を共有する)", async () => {
    const sub = subRepo.create({ name: "co2b", platform: "discord", enabled: true, guild_id: "g1" });
    const mgr = makeManager(async () => ({ stop: async () => {} }), {
      ...HEAD_WITH_TOKEN,
      token: null,
      guildId: null,
      applicationId: null,
    });
    expect((await mgr.start(sub.id)).status).toBe("missing_config");
  });

  it("slack 子会社は unsupported_platform (無言フォールバックしない)", async () => {
    const sub = subRepo.create({ name: "co3", platform: "slack", enabled: true, guild_id: "t1" });
    const mgr = makeManager(async () => ({ stop: async () => {} }));
    const r = await mgr.start(sub.id);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("unsupported_platform");
  });

  it("disabled 子会社は start で disabled", async () => {
    const sub = subRepo.create({ name: "co4", platform: "discord", enabled: false, guild_id: "g" });
    const mgr = makeManager(async () => ({ stop: async () => {} }));
    expect((await mgr.start(sub.id)).status).toBe("disabled");
  });

  it("startAll は enabled の discord 子会社のみ起動する", async () => {
    subRepo.create({ name: "a", platform: "discord", enabled: true, guild_id: "g" });
    subRepo.create({ name: "b", platform: "discord", enabled: false, guild_id: "g" });
    const startBot = vi.fn(async () => ({ stop: async () => {} }) as DiscordBotHandle);
    const mgr = makeManager(startBot);
    await mgr.startAll();
    expect(startBot).toHaveBeenCalledOnce();
    expect(mgr.runningIds().length).toBe(1);
  });
});
