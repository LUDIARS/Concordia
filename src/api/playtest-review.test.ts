import { describe, expect, it, vi } from "vitest";
import { playtestReviewRouter } from "./playtest-review.js";
import { createPlaytestReviewTargets } from "../playtest-review/playtest-review-targets.js";
import { createRecentRunLedger } from "../playtest-review/recent-run-ledger.js";

const BODY = {
  runId: "playtest:sample-novice-s1-20261015T000000Z",
  gameId: "sample",
  gameTitle: "Sample",
  persona: "novice",
  screen: "image",
  ticks: 40,
  turns: 3,
  outcome: "success",
  summary: "総評",
  good: [{ aspect: "game", text: "良い" }],
  bad: [{ aspect: "control", text: "悪い" }],
  confusions: [],
  reflection: ["反省"],
  voluptasId: null,
};

function app(authorize = (header: string | undefined) => header === "token") {
  const ccChannel = vi.fn();
  const router = playtestReviewRouter({
    ledger: createRecentRunLedger(),
    targets: createPlaytestReviewTargets({ discordChannelConfigured: () => true, slackWebhookConfigured: () => false }),
    delivery: { ccChannel, subsidiaryChannel: vi.fn(), discord: vi.fn(), slack: vi.fn() } as never,
    authorize,
  });
  const post = (body: unknown, token = "token") => router.request("/", { method: "POST", headers: { "content-type": "application/json", "x-excubitor-token": token }, body: JSON.stringify(body) });
  return { ccChannel, post };
}

describe("POST /v1/events/playtest-review", () => {
  it("accepts a review with good and bad points (202) and answers a resend as a duplicate (200)", async () => {
    const { ccChannel, post } = app();
    const first = await post(BODY);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ duplicate: false, unconfigured: false, failed: [] });
    expect((await post(BODY)).status).toBe(200);
    expect(ccChannel).toHaveBeenCalledTimes(1);
  });

  it("refuses a review without bad points or good points (CC-PLAYTEST-INV-03)", async () => {
    const { ccChannel, post } = app();
    expect((await post({ ...BODY, bad: [] })).status).toBe(400);
    expect((await post({ ...BODY, good: [] })).status).toBe(400);
    expect(ccChannel).not.toHaveBeenCalled();
  });

  it("refuses fields outside the contract, such as a webhook URL from the sender (CC-PLAYTEST-INV-01)", async () => {
    const { post } = app();
    expect((await post({ ...BODY, webhookUrl: "https://discord.com/api/webhooks/1/x" })).status).toBe(400);
    expect((await post({ ...BODY, good: [{ aspect: "game", text: "良い", userId: "u1" }] })).status).toBe(400);
  });

  it("needs the shared token", async () => {
    const { post } = app();
    expect((await post(BODY, "wrong")).status).toBe(401);
  });
});

describe("POST /v1/events/playtest-review with a run video", () => {
  function videoApp() {
    const discord = vi.fn().mockResolvedValue(undefined);
    const router = playtestReviewRouter({
      ledger: createRecentRunLedger(),
      targets: createPlaytestReviewTargets({ discordChannelConfigured: () => true, slackWebhookConfigured: () => false }),
      delivery: { ccChannel: vi.fn(), subsidiaryChannel: vi.fn(), discord: vi.fn(), slack: vi.fn() } as never,
      videoDelivery: { discord, slackReady: () => false, slack: vi.fn() },
      authorize: () => true,
    });
    const post = (form: FormData) => router.request("/", { method: "POST", body: form });
    return { discord, post };
  }

  function form(review: unknown, video?: Blob, name = "run.mp4"): FormData {
    const data = new FormData();
    data.append("review", new Blob([JSON.stringify(review)], { type: "application/json" }), "review.json");
    if (video) data.append("video", video, name);
    return data;
  }

  it("takes the review and the mp4 as multipart and attaches the video to the post", async () => {
    const { discord, post } = videoApp();
    const response = await post(form(BODY, new Blob([new Uint8Array([1, 2])], { type: "video/mp4" }), "../a b.mp4"));
    expect(response.status).toBe(202);
    expect((await response.json() as { video: unknown }).video).toEqual({ delivered: [{ target: { kind: "cc-channel", target: "" } }], failed: [] });
    expect(discord).toHaveBeenCalledWith(expect.stringContaining("総評"), { name: "a-b.mp4", bytes: new Uint8Array([1, 2]) });
  });

  it("refuses a video that is not mp4 or is empty, and a review part outside the contract", async () => {
    const { discord, post } = videoApp();
    expect((await post(form(BODY, new Blob(["x"], { type: "text/plain" })))).status).toBe(400);
    expect((await post(form(BODY, new Blob([], { type: "video/mp4" })))).status).toBe(400);
    expect((await post(form({ ...BODY, bad: [] }, new Blob([new Uint8Array([1])], { type: "video/mp4" })))).status).toBe(400);
    expect(discord).not.toHaveBeenCalled();
  });
});
