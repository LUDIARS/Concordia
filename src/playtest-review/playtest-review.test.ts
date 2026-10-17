import { describe, expect, it, vi } from "vitest";
import { handlePlaytestReview } from "./handle-playtest-review.js";
import { composePlaytestReviewNotice, PLAYTEST_NOTICE_LIMIT, type PlaytestReviewEvent } from "./playtest-review-notice.js";
import { createPlaytestReviewTargets, PLAYTEST_SLACK_WEBHOOK } from "./playtest-review-targets.js";
import { createRecentRunLedger } from "./recent-run-ledger.js";
import { createPlaytestReviewTabula, playtestTabulaPage } from "./playtest-review-tabula.js";

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
      .toEqual({ duplicate: false, unconfigured: true, delivered: [], failed: [], tabula: null });
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
    expect(outcome).toEqual({ duplicate: false, unconfigured: false, delivered: [], failed: [], tabula: { error: "tabula import failed: rejected (401)" } });
  });

  it("forgets the oldest run past its limit", () => {
    const ledger = createRecentRunLedger(2);
    expect([ledger.claim("a"), ledger.claim("b"), ledger.claim("c"), ledger.claim("a"), ledger.claim("c")]).toEqual([true, true, true, true, false]);
  });
});
