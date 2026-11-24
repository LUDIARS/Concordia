import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createInstructionEventRelay } from "../agent-instructions/instruction-events.js";
import { InstructionService } from "../agent-instructions/instruction-service.js";
import { SqliteAgentInstructionStore } from "../db/agent-instructions-repo.js";
import { SqliteMusePlaytestRelayStore } from "../db/muse-playtest-relays-repo.js";
import type { PlaytestReviewOutcome } from "./handle-playtest-review.js";
import { ANNOUNCE_UNKNOWN_ON_RESTART, MusePlaytestRelay } from "./muse-relay.js";
import { MUSE_RELAY_MAX_ATTEMPTS, type VoluptasAttempt } from "./muse-relay-policy.js";
import type { PlaytestReviewEvent } from "./playtest-review-notice.js";
import { saveVoluptasReview } from "./voluptas-client.js";

/** 実行ごとに作るテスト用の鍵 (リポジトリに鍵らしい文字列を置かない)。 */
const TOKEN = randomBytes(24).toString("hex");

const review = {
  runId: "run-muse-1",
  gameId: "kuzu-survivors",
  gameTitle: "KuzuSurvivors",
  persona: "casual",
  outcome: "cleared",
  screen: "image" as const,
  ticks: 1200,
  turns: 40,
  summary: "序盤は分かりやすいが中盤で迷う",
  good: [{ aspect: "ux" as const, text: "ボタンが大きい" }],
  bad: [{ aspect: "game" as const, text: "中盤の目標が分からない" }],
  confusions: [],
  reflection: ["地図を先に見るべきだった"],
};

const delivered: PlaytestReviewOutcome = {
  duplicate: false, unconfigured: false, delivered: [{ target: { kind: "cc-channel", target: "" } }], failed: [], tabula: null, video: null,
};

function setup(options: {
  connection?: { url: string; token: string } | null | "unreadable";
  save?: (body: Record<string, unknown>, runId: string) => Promise<VoluptasAttempt>;
  announce?: (event: PlaytestReviewEvent) => Promise<PlaytestReviewOutcome>;
  enabled?: boolean;
} = {}) {
  const db = makeTestDb();
  const clock = { now: Date.parse("2026-11-24T00:00:00Z") };
  const logs: Array<{ detail: Record<string, unknown>; message: string }> = [];
  const log = {
    info: (detail: Record<string, unknown>, message: string) => { logs.push({ detail, message }); },
    warn: (detail: Record<string, unknown>, message: string) => { logs.push({ detail, message }); },
  };
  const events = createInstructionEventRelay(log);
  const service = new InstructionService({ store: new SqliteAgentInstructionStore(db), now: () => new Date(clock.now), events: (event) => events.emit(event) });
  const saves: Array<{ body: Record<string, unknown>; runId: string }> = [];
  const announced: PlaytestReviewEvent[] = [];
  const notes: Array<{ id: string; text: string }> = [];
  const pending: Array<Promise<void>> = [];
  const connection = options.connection === undefined ? { url: "http://voluptas.lan:3000", token: TOKEN } : options.connection;
  const makeRelay = () => new MusePlaytestRelay({
    store: new SqliteMusePlaytestRelayStore(db),
    instructionType: (id) => service.get(id)?.type ?? null,
    enabled: () => options.enabled ?? true,
    voluptas: () => {
      if (connection === "unreadable") throw new Error("secret-box: cannot decrypt");
      return connection;
    },
    save: async (_connection, runId, body) => {
      saves.push({ body, runId });
      return options.save ? options.save(body, runId) : { kind: "saved", id: "aipt_0001" };
    },
    announce: async (event) => {
      announced.push(event);
      return options.announce ? options.announce(event) : delivered;
    },
    note: (id, _agent, text) => { notes.push({ id, text }); },
    log,
    now: () => clock.now,
  });
  let relay = makeRelay();
  events.subscribe((event) => { const run = relay.handle(event); pending.push(run); return run; });
  const settle = async () => { while (pending.length) await pending.shift(); };
  const finish = async (input: { agent?: "muse" | "dots"; type?: "playtest" | "run_task"; status?: "done" | "failed"; detail?: Record<string, unknown>; wait?: boolean }) => {
    const { id } = service.register({ agent: input.agent ?? "muse", type: input.type ?? "playtest", title: "試遊して", body: "遊んで感想を返して", params: {} });
    service.recordResult(id, { agent: input.agent ?? "muse", status: input.status ?? "done", summary: "遊びました", ...(input.detail ? { detail: input.detail } : {}) });
    if (input.wait === false) { pending.length = 0; await new Promise((resolve) => setTimeout(resolve, 20)); } else await settle();
    return id;
  };
  const store = new SqliteMusePlaytestRelayStore(db);
  return {
    db, clock, logs, saves, announced, notes, store, finish, settle,
    relay: () => relay,
    restart: () => { relay = makeRelay(); return relay; },
  };
}

describe("Muse の試遊結果の中継 (CC-MUSE-RELAY-INV-01)", () => {
  it("ignores instructions that are not muse / playtest / done", async () => {
    const env = setup();
    await env.finish({ agent: "dots", detail: { review } });
    await env.finish({ type: "run_task", detail: { review } });
    await env.finish({ status: "failed", detail: { review } });
    expect(env.saves).toHaveLength(0);
    expect(env.announced).toHaveLength(0);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM muse_playtest_relays").get()).toEqual({ n: 0 });
  });

  it("does nothing while the relay is turned off", async () => {
    const env = setup({ enabled: false });
    await env.finish({ detail: { review } });
    expect(env.saves).toHaveLength(0);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM muse_playtest_relays").get()).toEqual({ n: 0 });
  });
});

describe("detail.review の検証 (CC-MUSE-RELAY-INV-02)", () => {
  it("does not save or announce when review is missing, and leaves the reason in the ledger and the channel", async () => {
    const env = setup();
    const id = await env.finish({ detail: { note: "no review" } });
    expect(env.saves).toHaveLength(0);
    expect(env.announced).toHaveLength(0);
    expect(env.relay().view(id)).toMatchObject({ voluptasState: "skipped", announceState: "skipped", error: expect.stringContaining("review_missing") });
    expect(env.notes).toEqual([{ id, text: expect.stringContaining("review_missing") }]);
  });

  it("rejects a review without bad points", async () => {
    const env = setup();
    const id = await env.finish({ detail: { review: { ...review, bad: [] } } });
    expect(env.saves).toHaveLength(0);
    expect(env.announced).toHaveLength(0);
    expect(env.relay().view(id)?.error).toContain("review_invalid: bad");
  });
});

describe("Voluptas への保存と告知 (CC-MUSE-RELAY-INV-03 / 04)", () => {
  it("saves with the Voluptas allowlist, then announces once with the record id", async () => {
    const env = setup();
    const id = await env.finish({ detail: { review } });
    expect(env.saves).toHaveLength(1);
    expect(env.saves[0]!.runId).toBe("run-muse-1");
    expect(env.saves[0]!.body).toMatchObject({
      format: "ai-playtest-review/1", source: "ai-autoplayer", game_id: "kuzu-survivors", run_id: "run-muse-1",
      engine_version: "muse", adapter: "cc-muse-relay", created_at: "2026-11-24T00:00:00Z",
      good: [{ aspect: "ux", text: "ボタンが大きい", evidence: { ticks: [], shots: [] } }],
    });
    expect(Object.keys(env.saves[0]!.body).sort()).toEqual([
      "adapter", "bad", "confusions", "created_at", "engine_version", "format", "game_id", "game_title", "good", "outcome",
      "persona", "reflection", "run_id", "screen", "source", "summary", "ticks", "turns",
    ]);
    expect(env.announced).toEqual([{ ...review, voluptasId: "aipt_0001" }]);
    expect(env.relay().view(id)).toMatchObject({ voluptasState: "saved", voluptasId: "aipt_0001", announceState: "delivered" });
    expect(env.notes).toEqual([{ id, text: "中継: Voluptas 保存 aipt_0001 / 告知 1 件" }]);
    await env.relay().tick();
    expect(env.announced).toHaveLength(1);
  });

  it("retries a 5xx save and announces only after the save is confirmed", async () => {
    const answers: VoluptasAttempt[] = [{ kind: "rejected", status: 503, code: null }, { kind: "unavailable", reason: "ECONNREFUSED" }, { kind: "saved", id: "aipt_0002" }];
    const env = setup({ save: async () => answers.shift()! });
    const id = await env.finish({ detail: { review } });
    expect(env.announced).toHaveLength(0);
    expect(env.relay().view(id)).toMatchObject({ voluptasState: "pending", announceState: "pending", attempts: 1 });
    await env.relay().tick();
    expect(env.saves).toHaveLength(1);
    env.clock.now += 60_000;
    await env.relay().tick();
    expect(env.relay().view(id)).toMatchObject({ voluptasState: "pending", attempts: 2 });
    expect(env.announced).toHaveLength(0);
    env.clock.now += 120_000;
    await env.relay().tick();
    expect(env.announced).toEqual([{ ...review, voluptasId: "aipt_0002" }]);
    expect(env.relay().view(id)).toMatchObject({ voluptasState: "saved", attempts: 3, announceState: "delivered" });
  });

  it("gives up after the retry limit and announces without a record id", async () => {
    const env = setup({ save: async () => ({ kind: "rejected", status: 502, code: null }) });
    const id = await env.finish({ detail: { review } });
    for (let i = 1; i < MUSE_RELAY_MAX_ATTEMPTS; i++) {
      env.clock.now += 6 * 60 * 60 * 1000;
      await env.relay().tick();
    }
    expect(env.saves).toHaveLength(MUSE_RELAY_MAX_ATTEMPTS);
    expect(env.relay().view(id)).toMatchObject({ voluptasState: "failed", announceState: "delivered" });
    expect(env.announced).toEqual([{ ...review, voluptasId: null }]);
  });

  it("does not retry a 4xx and announces without a record id", async () => {
    const env = setup({ save: async () => ({ kind: "rejected", status: 401, code: "UNAUTHORIZED" }) });
    const id = await env.finish({ detail: { review } });
    env.clock.now += 6 * 60 * 60 * 1000;
    await env.relay().tick();
    expect(env.saves).toHaveLength(1);
    expect(env.relay().view(id)).toMatchObject({ voluptasState: "failed", announceState: "delivered" });
    expect(env.announced).toEqual([{ ...review, voluptasId: null }]);
    expect(env.notes[0]!.text).toContain("Voluptas 保存失敗");
  });

  it("skips the save and still announces when Voluptas is not configured", async () => {
    const env = setup({ connection: null });
    const id = await env.finish({ detail: { review } });
    expect(env.saves).toHaveLength(0);
    expect(env.announced).toEqual([{ ...review, voluptasId: null }]);
    expect(env.relay().view(id)).toMatchObject({ voluptasState: "skipped", announceState: "delivered" });
  });

  it("retries when the key cannot be read instead of skipping the save", async () => {
    const env = setup({ connection: "unreadable" });
    const id = await env.finish({ detail: { review } });
    expect(env.announced).toHaveLength(0);
    expect(env.relay().view(id)).toMatchObject({ voluptasState: "pending", error: expect.stringContaining("鍵を読めません") });
  });

  it("records an announcement that reached no destination as failed", async () => {
    const env = setup({ announce: async () => ({ ...delivered, delivered: [], failed: [{ target: { kind: "cc-channel", target: "" }, error: "HTTP 500" }] }) });
    const id = await env.finish({ detail: { review } });
    expect(env.relay().view(id)).toMatchObject({ announceState: "failed", error: expect.stringContaining("announce_failed") });
  });

  it("does not record the same instruction twice", async () => {
    const env = setup();
    const id = await env.finish({ detail: { review } });
    await env.relay().handle({ kind: "finished", id, agent: "muse", title: "試遊して", status: "done", summary: "遊びました", detail: JSON.stringify({ review }), finishedAt: "2026-11-24T00:00:00Z" });
    expect(env.saves).toHaveLength(1);
    expect(env.announced).toHaveLength(1);
  });
});

describe("再起動を跨いだ二重告知の止め (CC-MUSE-RELAY-INV-04)", () => {
  it("marks an interrupted announcement as unknown and never resends it", async () => {
    const env = setup({ announce: () => new Promise(() => {}) });
    const id = await env.finish({ detail: { review }, wait: false });
    expect(env.relay().view(id)).toMatchObject({ voluptasState: "saved", announceState: "announcing" });
    const restarted = env.restart();
    await restarted.resume();
    expect(restarted.view(id)).toMatchObject({ announceState: "failed", error: ANNOUNCE_UNKNOWN_ON_RESTART });
    await restarted.tick();
    expect(env.announced).toHaveLength(1);
  });

  it("resumes a saved row whose announcement had not started", async () => {
    const env = setup();
    env.store.insertIfAbsent({ instructionId: "inst:muse:20261124T000000Z:aaaaaa", runId: review.runId, finishedAt: "2026-11-24T00:00:00Z", reviewJson: JSON.stringify(review), voluptasState: "pending", announceState: "pending", error: null }, env.clock.now);
    env.store.recordSave("inst:muse:20261124T000000Z:aaaaaa", { state: "saved", voluptasId: "aipt_0009", error: null, attempts: 1, nextAttemptAt: null }, env.clock.now);
    await env.restart().resume();
    expect(env.saves).toHaveLength(0);
    expect(env.announced).toEqual([{ ...review, voluptasId: "aipt_0009" }]);
    await env.relay().resume();
    expect(env.announced).toHaveLength(1);
  });
});

describe("鍵を出さない (CC-MUSE-RELAY-INV-05)", () => {
  it("never writes the Voluptas key to logs, the ledger or the channel", async () => {
    const env = setup({ save: async () => ({ kind: "unavailable", reason: "connect failed" }) });
    await env.finish({ detail: { review } });
    const rows = env.db.prepare("SELECT * FROM muse_playtest_relays").all();
    const everything = JSON.stringify({ logs: env.logs, rows, notes: env.notes });
    expect(everything).not.toContain(TOKEN);
  });

  it("sends the key only as a Bearer header and redacts it from network errors", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const ok = await saveVoluptasReview({ url: "http://voluptas.lan:3000", token: TOKEN }, "run-1", { run_id: "run-1" }, async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { status: 201, json: async () => ({ ok: true, data: { review: { id: "aipt_x" } } }) };
    });
    expect(ok).toEqual({ kind: "saved", id: "aipt_x" });
    expect(calls[0]).toEqual({
      url: "http://voluptas.lan:3000/api/ai-playtests/reviews",
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "run-1", "content-type": "application/json" },
    });
    const failed = await saveVoluptasReview({ url: "http://v", token: TOKEN }, "run-1", {}, async () => { throw new Error(`bad ${TOKEN}`); });
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
    const rejected = await saveVoluptasReview({ url: "http://v", token: TOKEN }, "run-1", {}, async () => ({ status: 400, json: async () => ({ error: { code: "INVALID_AI_PLAYTEST_REVIEW", message: "x" } }) }));
    expect(rejected).toEqual({ kind: "rejected", status: 400, code: "INVALID_AI_PLAYTEST_REVIEW" });
    const replay = await saveVoluptasReview({ url: "http://v", token: TOKEN }, "run-1", {}, async () => ({ status: 200, json: async () => ({ ok: true, data: { review: { id: "aipt_x" } } }) }));
    expect(replay).toEqual({ kind: "saved", id: "aipt_x" });
  });
});

describe("再試行の間隔と状態の判定 (muse-relay-policy)", () => {
  it("doubles the wait from one minute up to six hours", async () => {
    const { retryDelayMs, decideAnnounce, relayNote } = await import("./muse-relay-policy.js");
    expect([1, 2, 3].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000]);
    expect(retryDelayMs(20)).toBe(6 * 60 * 60 * 1000);
    expect(decideAnnounce({ duplicate: true, unconfigured: false, delivered: 0, failed: 0, tabula: null })).toBe("delivered");
    expect(decideAnnounce({ duplicate: false, unconfigured: true, delivered: 0, failed: 0, tabula: null })).toBe("skipped");
    expect(decideAnnounce({ duplicate: false, unconfigured: false, delivered: 0, failed: 1, tabula: "posted" })).toBe("delivered");
    expect(relayNote({ voluptasState: "skipped", voluptasId: null, announceState: "skipped", announce: { duplicate: false, unconfigured: true, delivered: 0, failed: 0, tabula: null }, error: null, attempts: 0 }))
      .toBe("中継: Voluptas 保存なし (未設定または対象外) / 告知なし (宛先未設定)");
  });
});
