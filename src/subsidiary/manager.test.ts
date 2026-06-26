import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SubsidiaryRepo } from "../db/subsidiary-repo.js";
import { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { SubsidiaryBotManager, type BaseDiscordDeps } from "./manager.js";
import type { DiscordBotHandle } from "../discord/bot.js";

let db: ReturnType<typeof makeTestDb>;
let subRepo: SubsidiaryRepo;

function makeManager(startBot: () => Promise<DiscordBotHandle | null>) {
  return new SubsidiaryBotManager({
    subsidiaryRepo: subRepo,
    harnessRepo: new HarnessRulesRepo(db),
    delegationRepo: new DelegationRepo(db),
    delegationService: {} as never,
    // secret-box は平文を素通し (isEncrypted=false) する最小スタブ。
    secretBox: { encrypt: (s: string) => s, decrypt: (s: string) => s } as never,
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
  it("enabled+設定済み discord 子会社を start し running になる", async () => {
    const sub = subRepo.create({ name: "co", platform: "discord", enabled: true, guild_id: "g1", bot_token_enc: "tok" });
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

  it("token/guild 未設定なら missing_config", async () => {
    const sub = subRepo.create({ name: "co2", platform: "discord", enabled: true });
    const mgr = makeManager(async () => ({ stop: async () => {} }));
    expect((await mgr.start(sub.id)).status).toBe("missing_config");
  });

  it("slack 子会社は unsupported_platform (無言フォールバックしない)", async () => {
    const sub = subRepo.create({ name: "co3", platform: "slack", enabled: true, guild_id: "t1", bot_token_enc: "tok" });
    const mgr = makeManager(async () => ({ stop: async () => {} }));
    const r = await mgr.start(sub.id);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("unsupported_platform");
  });

  it("disabled 子会社は start で disabled", async () => {
    const sub = subRepo.create({ name: "co4", platform: "discord", enabled: false, guild_id: "g", bot_token_enc: "t" });
    const mgr = makeManager(async () => ({ stop: async () => {} }));
    expect((await mgr.start(sub.id)).status).toBe("disabled");
  });

  it("startAll は enabled の discord 子会社のみ起動する", async () => {
    subRepo.create({ name: "a", platform: "discord", enabled: true, guild_id: "g", bot_token_enc: "t" });
    subRepo.create({ name: "b", platform: "discord", enabled: false, guild_id: "g", bot_token_enc: "t" });
    const startBot = vi.fn(async () => ({ stop: async () => {} }) as DiscordBotHandle);
    const mgr = makeManager(startBot);
    await mgr.startAll();
    expect(startBot).toHaveBeenCalledOnce();
    expect(mgr.runningIds().length).toBe(1);
  });
});
