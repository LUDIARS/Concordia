import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import glabUnityTokenCommand, { issueReply, listReply, revokeReply, GLAB_UNITY_TOKEN_COMMAND } from "./glab-unity-token.js";
import { commandNamesForRegistration } from "../commands.js";
import { isCommandAvailableInGuild } from "../guild-scoped-commands.js";
import { isSubsidiaryAllowedCommand } from "../subsidiary-scope.js";
import { formatToken } from "../../glab-unity-hub/domain/token-policy.js";
import type { DiscordCommandDeps } from "../command-port.js";

const GLAB = "222222222222222222";

function interaction(sub: string, options: Record<string, string | null> = {}, guildId: string | null = GLAB) {
  const reply = vi.fn(async () => undefined);
  return {
    reply,
    user: { id: "111111111111111111" },
    guildId,
    options: {
      getSubcommand: () => sub,
      getString: (name: string) => options[name] ?? null,
    },
  };
}

describe("/glab-unity-token", () => {
  it("引数に対象ユーザーを持たない (発行は打った本人だけ)", () => {
    const json = glabUnityTokenCommand.builder.toJSON() as { name: string; options: Array<{ name: string; options?: Array<{ type: number }> }> };
    expect(json.name).toBe(GLAB_UNITY_TOKEN_COMMAND);
    expect(json.options.map((option) => option.name)).toEqual(["issue", "list", "revoke"]);
    // USER (6) / MENTIONABLE (9) の引数が無い。
    expect(json.options.flatMap((option) => option.options ?? []).some((option) => option.type === 6 || option.type === 9)).toBe(false);
  });

  it("本人の id と interaction の guild だけを use case に渡し、 ephemeral で返す", async () => {
    const token = formatToken(randomBytes(32));
    const port = {
      issue: vi.fn(() => ({ ok: true as const, token, displayPrefix: token.slice(0, 12), expiresAt: "2026-12-26T00:00:00.000Z", label: "pc" })),
      list: vi.fn(() => []),
      revoke: vi.fn(() => ({ ok: false as const, reason: "not_found" as const })),
    };
    const call = interaction("issue", { label: "pc" });
    await glabUnityTokenCommand.execute(call as never, { glabUnityTokens: port } as unknown as DiscordCommandDeps);
    expect(port.issue).toHaveBeenCalledWith({ discordUserId: "111111111111111111", guildId: GLAB }, "pc");
    const [arg] = call.reply.mock.calls[0] as unknown as [{ content: string; ephemeral: boolean }];
    expect(arg.ephemeral).toBe(true);
    expect(arg.content).toContain(token);
  });

  it("DM から打たれても guild は null のまま渡す (use case が断る)", async () => {
    const port = { issue: vi.fn(() => ({ ok: false as const, reason: "wrong_guild" as const })), list: vi.fn(), revoke: vi.fn() };
    const call = interaction("issue", {}, null);
    await glabUnityTokenCommand.execute(call as never, { glabUnityTokens: port } as unknown as DiscordCommandDeps);
    expect(port.issue).toHaveBeenCalledWith({ discordUserId: "111111111111111111", guildId: null }, null);
    expect((call.reply.mock.calls[0] as unknown as [{ content: string }])[0].content).toContain("GLab の Discord サーバーでだけ");
  });

  it("未設定なら案内だけ返す", async () => {
    const call = interaction("list");
    await glabUnityTokenCommand.execute(call as never, { glabUnityTokens: null } as unknown as DiscordCommandDeps);
    expect((call.reply.mock.calls[0] as unknown as [{ content: string; ephemeral: boolean }])[0]).toMatchObject({ ephemeral: true });
  });

  it("返信の文面", () => {
    expect(issueReply({ ok: false, reason: "limit_reached" })).toContain("3 本まで");
    expect(listReply([])).toContain("ありません");
    expect(revokeReply({ ok: true, displayPrefix: "glu" + "_abcdefgh" })).toContain("切断");
    expect(revokeReply({ ok: false, reason: "ambiguous" })).toContain("複数");
  });
});

describe("/glab-unity-token の登録先", () => {
  const resolve = () => GLAB;

  it("GLab の guild にだけ登録し、 他の guild には出さない", () => {
    expect(commandNamesForRegistration({ guildId: GLAB, resolveScopedGuild: resolve })).toContain(GLAB_UNITY_TOKEN_COMMAND);
    expect(commandNamesForRegistration({ guildId: "999999999999999999", resolveScopedGuild: resolve })).not.toContain(GLAB_UNITY_TOKEN_COMMAND);
    expect(commandNamesForRegistration({ resolveScopedGuild: resolve })).not.toContain(GLAB_UNITY_TOKEN_COMMAND);
  });

  it("GLab が子会社 guild でも登録・dispatch できる", () => {
    expect(commandNamesForRegistration({ subsidiary: true, guildId: GLAB, resolveScopedGuild: resolve })).toContain(GLAB_UNITY_TOKEN_COMMAND);
    expect(isSubsidiaryAllowedCommand(GLAB_UNITY_TOKEN_COMMAND)).toBe(true);
  });

  it("guild 限定の無いコマンドは常に出す、 対象 guild 未設定なら出さない", () => {
    expect(isCommandAvailableInGuild("spawn", null)).toBe(true);
    expect(isCommandAvailableInGuild(GLAB_UNITY_TOKEN_COMMAND, GLAB, () => null)).toBe(false);
  });
});
