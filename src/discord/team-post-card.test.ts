import { describe, expect, it, vi } from "vitest";
import { postTeamCard, truncateCardBody } from "./team-post-card.js";

function makeDeps(overrides: {
  channelId?: string | null;
  channel?: unknown;
  subsidiary?: boolean;
} = {}) {
  const send = vi.fn().mockResolvedValue(undefined);
  const channel = overrides.channel === undefined
    ? { isTextBased: () => true, send }
    : overrides.channel;
  const fetch = vi.fn().mockResolvedValue(channel);
  return {
    send,
    fetch,
    deps: {
      guild: { channels: { fetch } } as never,
      teamsRepo: {
        surfaceChannelId: () => (overrides.channelId === undefined ? "chan_1" : overrides.channelId),
      } as never,
      log: { info: vi.fn(), warn: vi.fn() },
      subsidiary: overrides.subsidiary,
    },
  };
}

const INPUT = { teamId: "team_1", kind: "standup" as const, title: "朝礼", body: "本文" };

describe("postTeamCard", () => {
  it("面が解決できたら embed を投稿する", async () => {
    const { deps, send } = makeDeps();

    await expect(postTeamCard(deps, INPUT)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ allowedMentions: { parse: [] } });
  });

  it("面が未プロビジョニングなら投稿せず false", async () => {
    const { deps, send } = makeDeps({ channelId: null });

    await expect(postTeamCard(deps, INPUT)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("課題スカウトのカードを紫色で投稿する", async () => {
    const { deps, send } = makeDeps();

    await expect(postTeamCard(deps, { ...INPUT, kind: "issue-hypothesis" })).resolves.toBe(true);
    expect(send.mock.calls[0][0].embeds[0].data.color).toBe(0x9b59b6);
    expect(send.mock.calls[0][0].embeds[0].data.author?.name).toBe("課題スカウト");
  });

  it("子会社 runtime でも caller が所有権を検証済みなら投稿する", async () => {
    const { deps, fetch, send } = makeDeps({ subsidiary: true });

    await expect(postTeamCard(deps, INPUT)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith("chan_1");
    expect(send).toHaveBeenCalledOnce();
  });

  it("チャンネルが取得できない / テキストでないなら false", async () => {
    const { deps } = makeDeps({ channel: null });

    await expect(postTeamCard(deps, INPUT)).resolves.toBe(false);
  });

  it("テキスト扱いでも send を持たないチャンネルなら false", async () => {
    const { deps } = makeDeps({ channel: { isTextBased: () => true } });

    await expect(postTeamCard(deps, INPUT)).resolves.toBe(false);
  });
});

describe("truncateCardBody", () => {
  it("上限以下はそのまま", () => {
    expect(truncateCardBody("abc", 10)).toBe("abc");
  });

  it("上限超過は切り詰めて省略量を明示する", () => {
    const result = truncateCardBody("a".repeat(15), 10);

    expect(result.startsWith("a".repeat(10))).toBe(true);
    expect(result).toContain("以下省略: 5 文字");
  });
});
