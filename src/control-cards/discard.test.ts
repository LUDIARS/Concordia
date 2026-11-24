import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { controlCardsRouter } from "../api/control-cards.js";
import type { CardSourceItem, CardSourceKind } from "./card-domain.js";
import { decideCardDiscard, planCardDiscards, type CardOwnership } from "./card-discard-policy.js";
import { readCardOwnership } from "./card-owner-sessions.js";
import { syncControlCards, type CardChange } from "./card-sync.js";
import type { SourceReading } from "./card-sync-policy.js";
import { createTriageDispatch } from "./card-triage-dispatch.js";
import { createHumanCommandCards } from "./human-command-cards.js";
import { runReminders } from "./reminder-runner.js";
import { ControlCardsRepository } from "./repository.js";
import { ControlCardsService } from "./service.js";
import { parseHumanCommandRequests } from "../discord/human-command-marker.js";

const NOW = 1_800_000_000_000;
const log = { info: () => {}, warn: () => {} };

function item(kind: CardSourceKind, key: string, sessionId: string | null): CardSourceItem {
  return { source_kind: kind, source_key: key, summary: `要旨 ${key}`, raised_at: NOW - 60_000, session_id: sessionId, project: "Cc", link: null };
}

const ownership = (active: string[], owners: Record<string, string> = {}): CardOwnership => ({
  activeSessions: new Set(active), confirmPendingOwner: (key) => owners[key] ?? null,
});

describe("破棄の判定 (実装メモ 14、純関数)", () => {
  it("keeps judgment cards of active sessions and discards those of inactive ones", () => {
    expect(decideCardDiscard(item("ask-card", "q1", "s1"), ownership(["s1"]))).toEqual({ kind: "keep" });
    expect(decideCardDiscard(item("human-wait", "w1", "gone"), ownership(["s1"]))).toEqual({ kind: "discard", reason: "session_inactive" });
  });

  it("judges session-less confirm-pending by the session that opened the PR", () => {
    const owners = { "confirm-pending:r1": "s1", "confirm-pending:r2": "ended" };
    expect(decideCardDiscard(item("confirm-pending", "confirm-pending:r1", null), ownership(["s1"], owners))).toEqual({ kind: "keep" });
    expect(decideCardDiscard(item("confirm-pending", "confirm-pending:r2", null), ownership(["s1"], owners))).toEqual({ kind: "discard", reason: "session_inactive" });
    expect(decideCardDiscard(item("confirm-pending", "confirm-pending:r3", null), ownership(["s1"], owners))).toEqual({ kind: "discard", reason: "session_unresolved" });
  });

  it("keeps judgments that do not belong to a session, session-less others and every human action", () => {
    const none = ownership([]);
    for (const kind of ["management-waiting-human", "director-blocked", "github-issue-approval"] as const) {
      expect(decideCardDiscard(item(kind, `${kind}:1`, "gone"), none)).toEqual({ kind: "keep" });
    }
    expect(decideCardDiscard(item("ask-card", "q-free", null), none)).toEqual({ kind: "keep" });
    expect(decideCardDiscard(item("human-command", "h1", "gone"), none)).toEqual({ kind: "keep" });
    expect(decideCardDiscard(item("session-unresponsive", "u1", "gone"), none)).toEqual({ kind: "keep" });
  });

  it("discards nothing when the ownership could not be read", () => {
    const plan = planCardDiscards({ openCards: [], create: [item("ask-card", "q1", "gone")], closing: new Set(), ownership: null });
    expect(plan).toEqual({ discard: [], createDiscarded: [], createOpen: [item("ask-card", "q1", "gone")] });
  });
});

function setup() {
  const db = makeTestDb();
  const repo = new ControlCardsRepository(db);
  let seq = 0;
  const changes: CardChange[] = [];
  const session = db.prepare(`INSERT INTO sessions (id, provider, repo_path, host, started_at, status, last_seen_at, metadata)
    VALUES (?, 'claude', 'E:/x', 'h', 1, ?, 1, '{}')`);
  session.run("alive", "active");
  session.run("ended", "ended");
  let ownershipFails = false;
  const sync = (readings: SourceReading[]) => syncControlCards({
    repo, sources: { read: () => readings }, sessionEnded: () => false,
    ownership: () => { if (ownershipFails) throw new Error("db busy"); return readCardOwnership(db); },
    now: () => NOW, id: () => `card-${++seq}`, onChange: (change) => changes.push(change), log,
  });
  const humanCommands = createHumanCommandCards({
    repo, parse: parseHumanCommandRequests, now: () => NOW, id: () => `card-${++seq}`, projectOf: () => "Cc", webUrl: (path) => path, log,
  });
  const service = new ControlCardsService(repo, humanCommands, () => NOW);
  return { db, repo, sync, changes, service, failOwnership: (value: boolean) => { ownershipFails = value; } };
}

function confirmRun(db: ReturnType<typeof makeTestDb>, id: string, prNumber: number, author: string | null) {
  db.prepare(`INSERT INTO confirm_runs (id, repo_origin, repo_name, pr_number, status, created_at, updated_at)
    VALUES (?, 'LUDIARS/Concordia', 'Concordia', ?, 'pending', 1, 1)`).run(id, prNumber);
  if (author !== undefined) {
    db.prepare(`INSERT INTO pr_records (repo_origin, number, title, state, author_session_id, created_at, updated_at)
      VALUES ('LUDIARS/Concordia', ?, 't', 'merged', ?, 1, 1)`).run(prNumber, author);
  }
}

describe("同期での破棄 (実装メモ 14、CC-V5-INV-08)", () => {
  it("discards open judgment cards whose session ended, keeps active ones, and never reopens them", () => {
    const h = setup();
    const readings: SourceReading[] = [{ kind: "ask-card", readable: true, items: [item("ask-card", "q-alive", "alive"), item("ask-card", "q-ended", "ended")] }];
    // 破棄の判定が読めない巡回では開いたまま作る (何も捨てない)。
    h.failOwnership(true);
    h.sync(readings);
    expect(h.repo.listOpen().map((card) => card.source_key).sort()).toEqual(["q-alive", "q-ended"]);
    h.failOwnership(false);
    h.sync(readings);
    expect(h.repo.listOpen().map((card) => card.source_key)).toEqual(["q-alive"]);
    expect(h.repo.findBySource("ask-card", "q-ended")).toMatchObject({ state: "discarded", discard_reason: "session_inactive", discarded_at: NOW, remind_at: null });
    // 出所がまだ開いていても開き直さない。
    h.sync(readings);
    h.sync(readings);
    expect(h.repo.findBySource("ask-card", "q-ended")?.state).toBe("discarded");
    // 破棄は依頼窓口へ知らせない。
    expect(h.changes.map((change) => `${change.kind}:${change.card.source_key}`)).toEqual(["opened:q-alive", "opened:q-ended"]);
  });

  it("creates new sources of inactive owners as discarded from the start, judging session-less confirm-pending by the PR author", () => {
    const h = setup();
    confirmRun(h.db, "r-alive", 1, "alive");
    confirmRun(h.db, "r-ended", 2, "ended");
    confirmRun(h.db, "r-unknown", 3, null);
    const readings: SourceReading[] = [
      { kind: "confirm-pending", readable: true, items: ["r-alive", "r-ended", "r-unknown"].map((id) => item("confirm-pending", `confirm-pending:${id}`, null)) },
      { kind: "management-waiting-human", readable: true, items: [item("management-waiting-human", "management:1", null)] },
    ];
    h.sync(readings);
    expect(h.repo.listOpen().map((card) => card.source_key).sort()).toEqual(["confirm-pending:r-alive", "management:1"]);
    expect(h.repo.findBySource("confirm-pending", "confirm-pending:r-ended")).toMatchObject({ state: "discarded", discard_reason: "session_inactive" });
    expect(h.repo.findBySource("confirm-pending", "confirm-pending:r-unknown")).toMatchObject({ state: "discarded", discard_reason: "session_unresolved" });
    // 出所は書き換えない (CC-V5-INV-02)。
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM confirm_runs WHERE status = 'pending'").get()).toEqual({ n: 3 });
    expect(h.changes.map((change) => change.card.source_key).sort()).toEqual(["confirm-pending:r-alive", "management:1"]);
  });

  it("leaves human action cards of ended sessions to their own rules", () => {
    const h = setup();
    h.sync([{ kind: "session-unresponsive", readable: true, items: [item("session-unresponsive", "unresponsive:ended", "ended")] }]);
    expect(h.repo.findBySource("session-unresponsive", "unresponsive:ended")?.state).toBe("open");
  });

  it("keeps discarded cards out of triage, reminders, the default listing and the per-session summary", async () => {
    const h = setup();
    h.sync([{ kind: "ask-card", readable: true, items: [item("ask-card", "q-alive", "alive"), item("ask-card", "q-ended", "ended")] }]);
    const discarded = h.repo.findBySource("ask-card", "q-ended")!;
    // 催促の時刻が来ていても出さない。
    h.db.prepare("UPDATE control_cards SET remind_at = ?").run(NOW - 1);
    const delivered: string[] = [];
    await runReminders({
      repo: h.repo, delivery: { deliver: async ({ card }) => { delivered.push(card.id); return "test"; } },
      now: () => NOW, isQuietHours: () => false, log,
    });
    expect(delivered).not.toContain(discarded.id);
    expect(delivered).toHaveLength(1);
    const registered: Array<Record<string, unknown>> = [];
    const settings = new Map<string, string>();
    createTriageDispatch({
      repo: h.repo, isEnabled: () => true, state: { get: (key) => settings.get(key) ?? null, set: (key, value) => { settings.set(key, value); } },
      register: (input) => { registered.push(input.params ?? {}); return { id: "inst-1" }; }, instructionStatus: () => null, now: () => NOW, log,
    }).tick();
    expect(JSON.stringify(registered)).not.toContain(discarded.id);
    expect(h.service.bySession("ended")).toEqual([]);
    // 人間の捌きも効かない (閉じたものと同じく 409)。
    expect(h.service.triage(discarded.id, { priority: "high" }, "neco")).toEqual({ kind: "closed" });

    const app = new Hono().route("/v1/control", controlCardsRouter({ service: h.service }));
    const byState = async (query: string) => (await (await app.request(`/v1/control/cards${query}`)).json()) as { cards: Array<{ id: string }>; discarded_count: number };
    const open = await byState("");
    expect(open.cards.map((card) => card.id)).not.toContain(discarded.id);
    expect(open.discarded_count).toBe(1);
    expect((await byState("?state=all")).cards.map((card) => card.id)).not.toContain(discarded.id);
    expect((await byState("?state=discarded")).cards.map((card) => card.id)).toEqual([discarded.id]);
  });
});
