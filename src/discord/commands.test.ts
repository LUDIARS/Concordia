import { describe, expect, it, vi } from "vitest";
import {
  commandNamesForRegistration,
  dispatchInteraction,
  isSubsidiaryAllowedCommand,
  isSubsidiaryAllowedInteraction,
} from "./commands.js";

describe("Discord command registration", () => {
  it("registers only safe session commands for subsidiary guilds", () => {
    expect(commandNamesForRegistration({ subsidiary: true })).toEqual(["ch_name"]);
    expect(isSubsidiaryAllowedCommand("ch_name")).toBe(true);
    expect(isSubsidiaryAllowedCommand("spawn")).toBe(false);
  });

  it("keeps the full command set for head-office guilds", () => {
    const names = commandNamesForRegistration();
    expect(names).toContain("cc-skill");
    expect(names).toContain("rv-prs");
    expect(names).toContain("spawn");
    expect(names).toContain("ch_name");
    expect(names).toContain("ex-run");
    expect(names).toContain("ex-reboot");
    expect(names).not.toContain("skill");
    expect(names.length).toBeGreaterThan(1);
  });

  it.each(["ctrl:spawn:codex", "ctrl:end-session"]) (
    "rejects subsidiary control interaction %s before dispatch",
    async (customId) => {
      const reply = vi.fn(async () => undefined);
      const interaction = {
        type: 3,
        customId,
        isAutocomplete: () => false,
        isRepliable: () => true,
        reply,
      };
      await dispatchInteraction(interaction as never, {
        subsidiaryId: "sub-1",
        log: { info: vi.fn(), warn: vi.fn() },
      } as never);
      expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
      expect(isSubsidiaryAllowedInteraction(interaction as never)).toBe(false);
    },
  );

  it.each([
    { userId: "", customId: undefined, label: "missing slash actor" },
    { userId: "discord-denied", customId: undefined, label: "unauthorized slash actor" },
    { userId: "discord-denied", customId: "ctrl:spawn-modal:codex", label: "unauthorized control-modal actor" },
  ])("rejects $label before spawn dispatch", async ({ userId, customId }) => {
    const reply = vi.fn(async () => undefined);
    const interaction = {
      type: customId ? 5 : 2,
      commandName: customId ? undefined : "spawn",
      customId,
      user: { id: userId },
      isAutocomplete: () => false,
      isRepliable: () => true,
      isChatInputCommand: () => !customId,
      isButton: () => false,
      isModalSubmit: () => Boolean(customId),
      reply,
    };
    await dispatchInteraction(interaction as never, {
      isLaunchUserAllowed: (id: string) => id === "discord-allowed",
      log: { info: vi.fn(), warn: vi.fn() },
    } as never);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("起動権限がありません"),
      ephemeral: true,
    }));
  });

  // 社員名簿の役職ゲート (spec/feature/staff-roster.md §3)。 capability ごとに別の判定関数を
  // 引くこと、 未注入なら deny (fail-closed) になることを固定する。
  const slash = (commandName: string, userId: string, reply: () => Promise<undefined>) => ({
    type: 2,
    commandName,
    user: { id: userId },
    isAutocomplete: () => false,
    isRepliable: () => true,
    isChatInputCommand: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    reply,
  });

  it.each([
    { commandName: "end-session", deny: "セッション終了権限がありません" },
    { commandName: "ex-run", deny: "サービス操作権限がありません" },
    { commandName: "ex-reboot", deny: "サービス操作権限がありません" },
  ])("denies /$commandName when only spawn permission is granted", async ({ commandName, deny }) => {
    const reply = vi.fn(async () => undefined);
    await dispatchInteraction(slash(commandName, "discord-allowed", reply) as never, {
      // spawn だけ許可された 管理職 相当。 end-session / キルスイッチは別 capability。
      isLaunchUserAllowed: () => true,
      log: { info: vi.fn(), warn: vi.fn() },
    } as never);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining(deny),
      ephemeral: true,
    }));
  });

  it("denies the kill switch for 管理職 and allows it only for 執行役員 checks", async () => {
    const denied = vi.fn(async () => undefined);
    await dispatchInteraction(slash("ex-run", "manager", denied) as never, {
      isSessionEndUserAllowed: () => true,
      isKillSwitchUserAllowed: (id: string) => id === "executive",
      log: { info: vi.fn(), warn: vi.fn() },
    } as never);
    expect(denied).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("執行役員のみ"),
    }));
  });

  it("denies privileged control-panel selects when no checker is injected (fail-closed)", async () => {
    const reply = vi.fn(async () => undefined);
    const interaction = {
      type: 3,
      customId: "ctrl:end-session:pick",
      user: { id: "discord-allowed" },
      isAutocomplete: () => false,
      isRepliable: () => true,
      isChatInputCommand: () => false,
      isButton: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => true,
      reply,
    };
    await dispatchInteraction(interaction as never, {
      log: { info: vi.fn(), warn: vi.fn() },
    } as never);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("セッション終了権限がありません"),
      ephemeral: true,
    }));
  });

  it("denies plan decisions when manager authorization is not wired", async () => {
    const reply = vi.fn(async () => undefined);
    const interaction = {
      type: 3,
      customId: "dirplan:approve:case-1:1",
      user: { id: "discord-user" },
      isAutocomplete: () => false,
      isRepliable: () => true,
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      reply,
    };
    await dispatchInteraction(interaction as never, {
      log: { info: vi.fn(), warn: vi.fn() },
    } as never);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("プラン承認・受け入れ権限"),
      ephemeral: true,
    }));
  });
});
