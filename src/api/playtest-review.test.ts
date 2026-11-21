import { describe, expect, it, vi } from "vitest";
import { playtestReviewRouter } from "./playtest-review.js";
import { createPlaytestReviewTargets } from "../playtest-review/playtest-review-targets.js";
import { createRecentRunLedger } from "../playtest-review/recent-run-ledger.js";
import { decidePlaytestReviewAuth, type PlaytestReviewAuthDecision } from "../playtest-review/playtest-review-auth.js";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ManagementRepository } from "../management/repository.js";
import { ManagementService } from "../management/service.js";

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

const ALLOW: PlaytestReviewAuthDecision = { allowed: true };
const byToken = (header: string | undefined): PlaytestReviewAuthDecision => (header === "token" ? ALLOW : { allowed: false, reason: "mismatch" });

function app(authorize = byToken, recordManagementEvent?: Parameters<typeof playtestReviewRouter>[0]["recordManagementEvent"]) {
  const ccChannel = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn() };
  const router = playtestReviewRouter({
    ledger: createRecentRunLedger(),
    targets: createPlaytestReviewTargets({ discordChannelConfigured: () => true, slackWebhookConfigured: () => false }),
    delivery: { ccChannel, subsidiaryChannel: vi.fn(), discord: vi.fn(), slack: vi.fn() } as never,
    authorize,
    recordManagementEvent,
    log,
  });
  const post = (body: unknown, token: string | null = "token") => router.request("/", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { "x-excubitor-token": token }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { ccChannel, log, post };
}

describe("POST /v1/events/playtest-review", () => {
  it("records the accepted review in the management feed once across intake restarts", async () => {
    const repo = new ManagementRepository(makeTestDb());
    const management = new ManagementService(repo, {
      now: () => 1, id: () => "", newToken: () => "", hashToken: () => "",
      departmentExists: () => false, liveSessions: () => [], inject: () => false,
    });
    const record: Parameters<typeof app>[1] = (event) => management.recordPlaytestReview(event);
    const first = app(byToken, record);
    expect((await first.post(BODY, "wrong")).status).toBe(401);
    expect(repo.eventsForProjects(["sample"], 0, 100)).toEqual([]);
    expect((await first.post(BODY)).status).toBe(202);
    expect((await first.post({ ...BODY, summary: "書き換え" })).status).toBe(200);
    expect((await app(byToken, record).post(BODY)).status).toBe(202);
    expect(repo.eventsForProjects(["sample"], 0, 100)).toEqual([expect.objectContaining({
      event_key: `ig:playtest-review:${BODY.runId}`, project_code: "sample", target_key: "game/sample",
      source: "ig", kind: "playtest-review", origin: "ai",
      summary: "Sample / success\n総評\n良い点 良い\n悪い点 悪い\n迷った点 なし",
    })]);
  });

  it("isolates management write failures from the response and retries the record on a resend", async () => {
    const record = vi.fn().mockImplementationOnce(() => { throw new Error("offline"); });
    const { post, ccChannel, log } = app(byToken, record);
    expect((await post(BODY)).status).toBe(202);
    expect((await post(BODY)).status).toBe(200);
    expect(record).toHaveBeenCalledTimes(2);
    expect(ccChannel).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({ runId: BODY.runId }, expect.stringContaining("management event"));
  });

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

  describe("with the dedicated intake token (CC-PLAYTEST-INV-07)", () => {
    const KEY = "m".repeat(48);
    const dedicated = (header: string | undefined) => decidePlaytestReviewAuth({
      presented: header,
      intakeToken: { kind: "set", value: KEY },
      legacy: () => true,
    });

    it("answers a missing or wrong key with 401 and does not deliver", async () => {
      const { ccChannel, post } = app(dedicated);
      const missing = await post(BODY, null);
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({ error: "unauthorized" });
      expect((await post(BODY, "wrong")).status).toBe(401);
      expect((await post(BODY, KEY.slice(1))).status).toBe(401);
      expect(ccChannel).not.toHaveBeenCalled();
    });

    it("checks the key before the body: a wrong key with a broken body is 401, the right key with a broken body is 400", async () => {
      const { post } = app(dedicated);
      expect((await post("{not json", "wrong")).status).toBe(401);
      expect((await post({ ...BODY, good: [] }, "wrong")).status).toBe(401);
      expect((await post({ ...BODY, good: [] }, KEY)).status).toBe(400);
    });

    it("keeps 202 and the 200 duplicate for the right key", async () => {
      const { post } = app(dedicated);
      expect((await post(BODY, KEY)).status).toBe(202);
      const again = await post(BODY, KEY);
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ duplicate: true });
    });

    it("logs the rejection without the key, the presented value or anything from the body", async () => {
      const { log, post } = app(dedicated);
      await post(BODY, "presented-secret-value");
      expect(log.warn).toHaveBeenCalledTimes(1);
      const [detail, message] = log.warn.mock.calls[0]!;
      expect(detail).toEqual({ reason: "mismatch" });
      expect(message).toBe("playtest-review rejected an unauthorized request");
      const logged = JSON.stringify(log.warn.mock.calls);
      for (const leaked of [KEY, "presented-secret-value", BODY.runId]) expect(logged).not.toContain(leaked);
    });
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
      authorize: () => ALLOW,
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
