import { describe, expect, it, vi } from "vitest";
import { handlePlaytestReview } from "./handle-playtest-review.js";
import { composePlaytestReviewNotice, PLAYTEST_NOTICE_LIMIT, type PlaytestReviewEvent } from "./playtest-review-notice.js";
import { createPlaytestReviewTargets, PLAYTEST_SLACK_WEBHOOK } from "./playtest-review-targets.js";
import { createRecentRunLedger } from "./recent-run-ledger.js";
import { createPlaytestReviewTabula, playtestTabulaPage } from "./playtest-review-tabula.js";
import { createPlaytestVideoDelivery, type PlaytestVideoDelivery } from "./playtest-review-video.js";

const PLAYTEST_EVENT: PlaytestReviewEvent = {
  runId: "playtest:sample-novice-s1-20261015T000000Z",
  gameId: "sample",
  gameTitle: "Sample",
  persona: "novice",
  screen: "text",
  ticks: 40,
  turns: 3,
  outcome: "success",
  summary: "攻撃の流れは分かりやすいが体力の減り方が読みにくい。",
  good: [{ aspect: "control", text: "攻撃が素直に当たる。" }],
  bad: [{ aspect: "ux", text: "体力の減りが画面から分かりにくい。" }],
  confusions: [],
  reflection: ["敵の位置を確かめる前に動いた。"],
  voluptasId: "aipt_0123456789abcdef01234567",
};

function delivery(overrides: Partial<Record<"ccChannel" | "subsidiaryChannel" | "discord" | "slack", unknown>> = {}) {
  return { ccChannel: vi.fn(), subsidiaryChannel: vi.fn(), discord: vi.fn(), slack: vi.fn(), ...overrides } as never;
}

const BOTH = createPlaytestReviewTargets({ discordChannelConfigured: () => true, slackWebhookConfigured: () => true });

describe("playtest-review notice", () => {
  it("lists good points, bad points, the reflection and the Voluptas record", () => {
    const text = composePlaytestReviewNotice(PLAYTEST_EVENT);
    expect(text).toContain("🎮 AI プレイテスト: Sample");
    expect(text).toContain("👍 良い点\n・[操作感] 攻撃が素直に当たる。");
    expect(text).toContain("👎 悪い点\n・[UX] 体力の減りが画面から分かりにくい。");
    expect(text).toContain("🔁 AI の反省\n・敵の位置を確かめる前に動いた。");
    expect(text).toContain("Voluptas 記録: aipt_0123456789abcdef01234567");
    expect(text).not.toContain("迷ったところ");
  });

  it("is cut to one Discord message", () => {
    expect(composePlaytestReviewNotice({ ...PLAYTEST_EVENT, summary: "あ".repeat(5000) }).length).toBeLessThanOrEqual(PLAYTEST_NOTICE_LIMIT);
  });
});

describe("playtest-review delivery", () => {
  it("posts once to the configured Discord channel and Slack webhook (CC-PLAYTEST-INV-01)", async () => {
    const bot = delivery();
    const outcome = await handlePlaytestReview({ event: PLAYTEST_EVENT, ledger: createRecentRunLedger(), targets: BOTH, delivery: bot });
    expect(outcome).toEqual({
      duplicate: false,
      unconfigured: false,
      delivered: [{ target: { kind: "cc-channel", target: "" } }, { target: { kind: "slack", target: PLAYTEST_SLACK_WEBHOOK } }],
      failed: [],
      tabula: null,
      video: null,
    });
    const calls = bot as unknown as { ccChannel: ReturnType<typeof vi.fn>; slack: ReturnType<typeof vi.fn> };
    expect(calls.ccChannel).toHaveBeenCalledWith(expect.stringContaining("👎 悪い点"));
    expect(calls.slack).toHaveBeenCalledWith(PLAYTEST_SLACK_WEBHOOK, expect.stringContaining("👍 良い点"));
  });

  it("does not post the same run twice (CC-PLAYTEST-INV-02)", async () => {
    const ledger = createRecentRunLedger();
    const bot = delivery();
    await handlePlaytestReview({ event: PLAYTEST_EVENT, ledger, targets: BOTH, delivery: bot });
    const again = await handlePlaytestReview({ event: PLAYTEST_EVENT, ledger, targets: BOTH, delivery: bot });
    expect(again.duplicate).toBe(true);
    expect((bot as unknown as { ccChannel: ReturnType<typeof vi.fn> }).ccChannel).toHaveBeenCalledTimes(1);
  });

  it("reports unconfigured without delivering, and one failing destination does not stop the other (CC-PLAYTEST-INV-04)", async () => {
    const none = createPlaytestReviewTargets({ discordChannelConfigured: () => false, slackWebhookConfigured: () => false });
    expect(await handlePlaytestReview({ event: PLAYTEST_EVENT, ledger: createRecentRunLedger(), targets: none, delivery: delivery() }))
      .toEqual({ duplicate: false, unconfigured: true, delivered: [], failed: [], tabula: null, video: null });
    const broken = delivery({ ccChannel: vi.fn().mockRejectedValue(new Error("playtest Discord channel rejected request (403)")) });
    const outcome = await handlePlaytestReview({ event: PLAYTEST_EVENT, ledger: createRecentRunLedger(), targets: BOTH, delivery: broken });
    expect(outcome.delivered).toEqual([{ target: { kind: "slack", target: PLAYTEST_SLACK_WEBHOOK } }]);
    expect(outcome.failed).toEqual([{ target: { kind: "cc-channel", target: "" }, error: "playtest Discord channel rejected request (403)" }]);
  });

  it("posts the same notice to Tabula as one page per run when the setting is on (CC-PLAYTEST-INV-05)", async () => {
    const importPage = vi.fn().mockResolvedValue({ pageId: "p1", url: "https://tabula.example.com/p/p1" });
    const tabula = createPlaytestReviewTabula({ enabled: () => true, connection: () => ({ url: "https://tabula.example.com", token: "t" }), importPage });
    const outcome = await handlePlaytestReview({ event: PLAYTEST_EVENT, ledger: createRecentRunLedger(), targets: BOTH, delivery: delivery(), tabula });
    expect(outcome.tabula).toEqual({ url: "https://tabula.example.com/p/p1" });
    const page = importPage.mock.calls[0]?.[1] as { key: string; title: string; text: string; tags: string[] };
    expect(page.key).toBe(`playtest:${PLAYTEST_EVENT.runId}`);
    expect(page.text).toContain("👎 悪い点");
    expect(page.tags).toContain("ai-playtest");
    expect(playtestTabulaPage(PLAYTEST_EVENT, "x").title).toBe("AI プレイテスト: Sample (novice)");
  });

  it("leaves Tabula alone when the setting is off, and reports a missing connection or a failure without stopping the chat", async () => {
    const importPage = vi.fn();
    const off = createPlaytestReviewTabula({ enabled: () => false, connection: () => ({ url: "u", token: "t" }), importPage });
    expect((await handlePlaytestReview({ event: PLAYTEST_EVENT, ledger: createRecentRunLedger(), targets: BOTH, delivery: delivery(), tabula: off })).tabula).toBeNull();
    expect(importPage).not.toHaveBeenCalled();
    const unset = createPlaytestReviewTabula({ enabled: () => true, connection: () => null, importPage });
    const missing = await handlePlaytestReview({ event: PLAYTEST_EVENT, ledger: createRecentRunLedger(), targets: BOTH, delivery: delivery(), tabula: unset });
    expect(missing.tabula).toEqual({ error: expect.stringContaining("not set") });
    expect(missing.delivered).toHaveLength(2);
    const none = createPlaytestReviewTargets({ discordChannelConfigured: () => false, slackWebhookConfigured: () => false });
    const onlyTabula = createPlaytestReviewTabula({ enabled: () => true, connection: () => ({ url: "u", token: "t" }), importPage: vi.fn().mockRejectedValue(new Error("tabula import failed: rejected (401)")) });
    const outcome = await handlePlaytestReview({ event: PLAYTEST_EVENT, ledger: createRecentRunLedger(), targets: none, delivery: delivery(), tabula: onlyTabula });
    expect(outcome).toEqual({ duplicate: false, unconfigured: false, delivered: [], failed: [], tabula: { error: "tabula import failed: rejected (401)" }, video: null });
  });

  it("forgets the oldest run past its limit", () => {
    const ledger = createRecentRunLedger(2);
    expect([ledger.claim("a"), ledger.claim("b"), ledger.claim("c"), ledger.claim("a"), ledger.claim("c")]).toEqual([true, true, true, true, false]);
  });
});

describe("playtest-review video (CC-PLAYTEST-INV-06)", () => {
  const VIDEO = { name: "run.mp4", bytes: new Uint8Array([1, 2, 3]) };

  function videoDelivery(overrides: Partial<PlaytestVideoDelivery> = {}): PlaytestVideoDelivery {
    return { discord: vi.fn().mockResolvedValue(undefined), slackReady: () => true, slack: vi.fn().mockResolvedValue(undefined), ...overrides };
  }

  it("posts the notice with the video on Discord and Slack instead of the text-only posts", async () => {
    const bot = delivery();
    const transport = videoDelivery();
    const outcome = await handlePlaytestReview({ event: PLAYTEST_EVENT, ledger: createRecentRunLedger(), targets: BOTH, delivery: bot, video: VIDEO, videoDelivery: transport });
    expect(outcome.delivered).toEqual([{ target: { kind: "cc-channel", target: "" } }, { target: { kind: "slack", target: PLAYTEST_SLACK_WEBHOOK } }]);
    expect(outcome.video).toEqual({ delivered: outcome.delivered, failed: [] });
    expect(transport.discord).toHaveBeenCalledWith(expect.stringContaining("👍 良い点"), VIDEO);
    expect(transport.slack).toHaveBeenCalledWith(expect.stringContaining("👎 悪い点"), VIDEO);
    const calls = bot as unknown as { ccChannel: ReturnType<typeof vi.fn>; slack: ReturnType<typeof vi.fn> };
    expect(calls.ccChannel).not.toHaveBeenCalled();
    expect(calls.slack).not.toHaveBeenCalled();
  });

  it("still delivers the notice as text where the video cannot go, and says why", async () => {
    const bot = delivery();
    const transport = videoDelivery({ discord: vi.fn().mockRejectedValue(new Error("playtest Discord channel rejected the video (413)")), slackReady: () => false });
    const outcome = await handlePlaytestReview({ event: PLAYTEST_EVENT, ledger: createRecentRunLedger(), targets: BOTH, delivery: bot, video: VIDEO, videoDelivery: transport });
    expect(outcome.delivered).toHaveLength(2);
    expect(outcome.failed).toEqual([]);
    expect(outcome.video).toEqual({
      delivered: [],
      failed: [
        { target: { kind: "cc-channel", target: "" }, error: "playtest Discord channel rejected the video (413)" },
        { target: { kind: "slack", target: PLAYTEST_SLACK_WEBHOOK }, error: "playtest Slack video channel is not configured" },
      ],
    });
    const calls = bot as unknown as { ccChannel: ReturnType<typeof vi.fn>; slack: ReturnType<typeof vi.fn> };
    expect(calls.ccChannel).toHaveBeenCalledTimes(1);
    expect(calls.slack).toHaveBeenCalledTimes(1);
  });

  it("sends Discord one multipart message and Slack an external upload with the notice as its comment", async () => {
    const fetched: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      fetched.push({ url, init });
      if (url.endsWith("files.getUploadURLExternal")) return Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/x", file_id: "F1" });
      if (url.endsWith("files.completeUploadExternal")) return Response.json({ ok: true });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const transport = createPlaytestVideoDelivery({ fetchImpl, discord: () => ({ channelId: "123", token: "dtoken" }), slack: () => ({ channelId: "C1", token: "xoxb" }) });
    await transport.discord("本文", VIDEO);
    const form = fetched[0]?.init.body as FormData;
    expect(fetched[0]?.url).toBe("https://discord.com/api/v10/channels/123/messages");
    expect(JSON.parse(String(form.get("payload_json")))).toEqual({ content: "本文", allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: "run.mp4" }] });
    expect((form.get("files[0]") as File).size).toBe(3);
    await transport.slack("本文 <!channel>", VIDEO);
    expect(fetched.slice(1).map((call) => call.url)).toEqual(["https://slack.com/api/files.getUploadURLExternal", "https://files.slack.com/upload/v1/x", "https://slack.com/api/files.completeUploadExternal"]);
    const complete = JSON.parse(String(fetched[3]?.init.body)) as { channel_id: string; initial_comment: string; files: unknown };
    expect(complete.channel_id).toBe("C1");
    expect(complete.files).toEqual([{ id: "F1", title: "run.mp4" }]);
    expect(complete.initial_comment).not.toContain("<!channel>");
    const unset = createPlaytestVideoDelivery({ fetchImpl, discord: () => ({ channelId: "1", token: "t" }), slack: () => null });
    expect(unset.slackReady()).toBe(false);
    await expect(unset.slack("x", VIDEO)).rejects.toThrow("not configured");
  });

  it("reports a Slack API refusal without the token", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: false, error: "not_in_channel" })) as unknown as typeof fetch;
    const transport = createPlaytestVideoDelivery({ fetchImpl, discord: () => ({ channelId: "1", token: "t" }), slack: () => ({ channelId: "C1", token: "xoxb-secret" }) });
    await expect(transport.slack("x", VIDEO)).rejects.toThrow("slack files.getUploadURLExternal failed (not_in_channel)");
  });
});
