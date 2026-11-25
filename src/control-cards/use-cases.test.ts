import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { syncControlCards, type CardChange } from "./card-sync.js";
import { createTriageDispatch, TRIAGE_STATE_KEY } from "./card-triage-dispatch.js";
import type { SourceReading } from "./card-sync-policy.js";
import { createHumanCommandCards } from "./human-command-cards.js";
import { runReminders } from "./reminder-runner.js";
import { REMINDER_MIN_INTERVAL_MS } from "./reminder-policy.js";
import { ControlCardsRepository } from "./repository.js";
import { ControlCardsService } from "./service.js";
import { createCardSources } from "./sources.js";
import { parseHumanCommandRequests } from "../discord/human-command-marker.js";

const NOW = 1_800_000_000_000;
const log = { info: () => {}, warn: () => {} };

function setup() {
  const db = makeTestDb();
  const repo = new ControlCardsRepository(db);
  let seq = 0;
  let now = NOW;
  const changes: CardChange[] = [];
  const humanCommands = createHumanCommandCards({
    repo, parse: parseHumanCommandRequests, now: () => now, id: () => `card-${++seq}`, projectOf: () => "Cc", webUrl: (path) => `http://cc${path}`,
    onChange: (change) => changes.push(change), log,
  });
  const service = new ControlCardsService(repo, humanCommands, () => now);
  const sync = (readings: SourceReading[], ended: (id: string) => boolean | null = () => false) => syncControlCards({
    repo, sources: { read: () => readings }, sessionEnded: ended, now: () => now, id: () => `card-${++seq}`, onChange: (change) => changes.push(change), log,
  });
  return { db, repo, service, humanCommands, sync, changes, advance: (ms: number) => { now += ms; }, now: () => now };
}

const ask = (key: string) => ({ source_kind: "ask-card" as const, source_key: key, summary: `質問 ${key}`, raised_at: NOW, session_id: "s1", project: "Cc", link: null });

describe("カードの同期 (CC-V5-INV-02 / 03)", () => {
  it("opens a card per unresolved source item, closes it when resolved and does not close on an unreadable patrol", () => {
    const h = setup();
    h.sync([{ kind: "ask-card", readable: true, items: [ask("q1")] }]);
    const [opened] = h.repo.listOpen();
    expect(opened).toMatchObject({ source_kind: "ask-card", source_key: "q1", card_kind: "human_judgment", priority: "normal", remind_at: NOW + 86_400_000 });
    h.sync([{ kind: "ask-card", readable: false, error: "busy" }]);
    expect(h.repo.find(opened!.id)?.state).toBe("open");
    h.sync([{ kind: "ask-card", readable: true, items: [] }]);
    expect(h.repo.find(opened!.id)).toMatchObject({ state: "closed", close_reason: "source_resolved" });
    expect(h.changes.map((change) => change.kind)).toEqual(["opened", "closed"]);
  });

  it("reads the existing sources without writing them (human-wait, board unresponsive, management, ask cards)", () => {
    const h = setup();
    h.db.prepare(`INSERT INTO sessions (id, provider, repo_path, host, started_at, status, last_seen_at, metadata)
      VALUES ('s1', 'claude', 'E:/x', 'h', 1, 'active', 1, ?)`).run(JSON.stringify({ cc_human_wait: {
      active: true, summary: "承認待ち", human_action: "反映を承認する", task_references: [], since: NOW,
    } }));
    h.db.prepare(`INSERT INTO control_progress_board (session_id, project, updated_at, status, status_reason, classified_at)
      VALUES ('s1', 'Cc', 1, 'unresponsive', '反応なし', 100)`).run();
    const readings = createCardSources(h.db, { projectOf: () => "Cc", webUrl: (path) => path }).read();
    const byKind = Object.fromEntries(readings.map((reading) => [reading.kind, reading]));
    expect(readings.every((reading) => reading.readable)).toBe(true);
    expect(byKind["human-wait"]).toMatchObject({ items: [{ source_key: `human-wait:s1:${NOW}`, summary: "人間待ち: 承認待ち", raised_at: NOW }] });
    expect(byKind["session-unresponsive"]).toMatchObject({ items: [{ source_key: "unresponsive:s1", raised_at: 100_000 }] });
    h.sync(readings);
    expect(h.repo.listOpen().map((row) => row.source_kind).sort()).toEqual(["human-wait", "session-unresponsive"]);
    expect(h.repo.listOpen().find(row => row.source_kind === "human-wait")?.human_action).toBe("反映を承認する");
    expect(h.db.prepare("SELECT status FROM control_progress_board WHERE session_id = 's1'").get()).toEqual({ status: "unresponsive" });
  });
});

describe("人間依頼のカード (実装メモ 6)", () => {
  const marker = "やってください\n```human-command\n{\"description\":\"ログイン\",\"command\":\"gh auth login\"}\n```";

  it("creates one card per marker, ignores redelivery and closes only by done / OK", () => {
    const h = setup();
    const message = { sessionId: "s1", messageId: 42, authorType: "assistant", content: marker };
    expect(h.humanCommands.onSessionMessage(message)).toHaveLength(1);
    expect(h.humanCommands.onSessionMessage(message)).toHaveLength(0);
    expect(h.humanCommands.onSessionMessage({ ...message, authorType: "user" })).toHaveLength(0);
    const [card] = h.repo.listOpen();
    expect(card).toMatchObject({ source_kind: "human-command", source_key: "42:0", card_kind: "human_action" });
    // 出所を読む巡回では閉じない。
    h.sync([]);
    expect(h.repo.find(card!.id)?.state).toBe("open");
    expect(h.service.markHumanCommandDone(42, 0, "discord:1")).toMatchObject({ state: "closed", close_reason: "done_by:discord:1" });
  });

  it("refuses to close a source-owned card from the card (CC-V5-INV-02) but lets humans triage it", () => {
    const h = setup();
    h.sync([{ kind: "ask-card", readable: true, items: [ask("q1")] }]);
    const [card] = h.repo.listOpen();
    expect(h.service.markDone(card!.id, "web")).toEqual({ kind: "not_owned" });
    const updated = h.service.triage(card!.id, { priority: "high", assignee: "neco" }, "web");
    expect(updated).toMatchObject({ kind: "updated", card: { priority: "high", assignee: "neco", triaged_by: "human:web", state: "open" } });
  });
});

describe("dots への捌きの指令", () => {
  function triage(h: ReturnType<typeof setup>, enabled = true) {
    const store = new Map<string, string>();
    const registered: Array<{ id: string; type: string; agent: string; params: Record<string, unknown> }> = [];
    const statuses = new Map<string, string>();
    const dispatch = createTriageDispatch({
      repo: h.repo, isEnabled: () => enabled,
      state: { get: (k) => store.get(k) ?? null, set: (k, v) => { store.set(k, v); } },
      register: (input) => { const id = `inst:dots:${registered.length + 1}`; registered.push({ id, ...input }); statuses.set(id, "pending"); return { id }; },
      instructionStatus: (id) => statuses.get(id) ?? null,
      now: h.now, log,
    });
    return { dispatch, registered, statuses, store };
  }

  it("registers one card_triage for dots and waits for it before the next one", () => {
    const h = setup();
    const t = triage(h);
    h.sync([{ kind: "ask-card", readable: true, items: [ask("q1")] }]);
    expect(t.dispatch.tick()).toEqual({ kind: "register" });
    expect(t.registered[0]).toMatchObject({ agent: "dots", type: "card_triage" });
    h.sync([{ kind: "ask-card", readable: true, items: [ask("q1"), ask("q2")] }]);
    h.advance(11 * 60_000);
    expect(t.dispatch.tick()).toMatchObject({ reason: "previous_unfinished" });
    t.statuses.set("inst:dots:1", "done");
    expect(t.dispatch.tick()).toEqual({ kind: "register" });
    expect(JSON.parse(t.store.get(TRIAGE_STATE_KEY)!)).toMatchObject({ instruction_id: "inst:dots:2" });
  });

  it("applies only the latest own instruction's done result, records dots:<id> and drops out-of-scope entries (CC-V5-INV-04)", () => {
    const h = setup();
    const t = triage(h);
    h.sync([{ kind: "ask-card", readable: true, items: [ask("q1")] }]);
    t.dispatch.tick();
    const [card] = h.repo.listOpen();
    const detail = JSON.stringify({ cards: [{ card_id: card!.id, priority: "high" }, { card_id: "unknown", priority: "low" }] });
    const finished = (id: string, status: "done" | "failed" = "done") => ({ kind: "finished" as const, id, agent: "dots", title: "管制カードの捌き (1 件)", status, summary: "ok", detail, finishedAt: "" });
    expect(t.dispatch.onInstructionEvent(finished("inst:dots:other"))).toBeNull();
    expect(t.dispatch.onInstructionEvent(finished("inst:dots:1", "failed"))).toBeNull();
    const applied = t.dispatch.onInstructionEvent(finished("inst:dots:1"));
    expect(applied?.apply).toHaveLength(1);
    expect(applied?.dropped).toEqual([{ card_id: "unknown", reason: "不明か閉じたカード" }]);
    expect(h.repo.find(card!.id)).toMatchObject({ priority: "high", triaged_by: "dots:inst:dots:1", state: "open" });
  });

  it("does nothing while dots triage is off; cards keep the default triage", () => {
    const h = setup();
    const t = triage(h, false);
    h.sync([{ kind: "ask-card", readable: true, items: [ask("q1")] }]);
    expect(t.dispatch.tick()).toMatchObject({ reason: "disabled" });
    expect(t.registered).toHaveLength(0);
    expect(h.repo.listOpen()[0]).toMatchObject({ priority: "normal", remind_at: NOW + 86_400_000 });
  });

  it("fills an empty action, preserves it on ordinary sync, and prefers action supplied by the source", () => {
    const h = setup();
    const t = triage(h);
    const item = ask("q1");
    const sync = (source: typeof item & { human_action?: string }) => h.sync([{ kind: "ask-card", readable: true, items: [source] }]);
    sync(item);
    t.dispatch.tick();
    const [card] = h.repo.listOpen();
    const finished = {
      kind: "finished" as const, id: "inst:dots:1", agent: "dots", title: "捌き", status: "done" as const, summary: "完了",
      detail: JSON.stringify({ cards: [{ card_id: card!.id, human_action: "申請を確認する" }] }), finishedAt: "",
    };
    t.dispatch.onInstructionEvent(finished);
    sync({ ...item, summary: "更新した要旨" });
    expect(h.repo.find(card!.id)?.human_action).toBe("申請を確認する");
    sync({ ...item, summary: "更新した要旨", human_action: "反映を承認する" });
    t.dispatch.onInstructionEvent(finished);
    expect(h.repo.find(card!.id)?.human_action).toBe("反映を承認する");
  });
});

describe("催促の送信 (CC-V5-INV-05)", () => {
  it("sends once when due, records it, waits 30 minutes and skips quiet hours", async () => {
    const h = setup();
    h.sync([{ kind: "ask-card", readable: true, items: [ask("q1")] }]);
    const [card] = h.repo.listOpen();
    h.repo.triage(card!.id, { remind_at: NOW, assignee: "123456789012345678" }, "human:web", NOW);
    const sent: Array<{ text: string; mention: string | null }> = [];
    let quiet = false;
    const run = () => runReminders({
      repo: h.repo, now: h.now, isQuietHours: () => quiet, log,
      delivery: { deliver: async ({ text, mentionUserId }) => { sent.push({ text, mention: mentionUserId }); return "desk-thread:1"; } },
    });
    expect(await run()).toEqual([card!.id]);
    expect(sent[0]!.mention).toBe("123456789012345678");
    expect(h.repo.reminders(card!.id)).toHaveLength(1);
    // 次の予定は 24 時間後。dots が早めても 30 分は空ける。
    h.repo.triage(card!.id, { remind_at: h.now() }, "dots:x", h.now());
    expect(await run()).toEqual([]);
    h.advance(REMINDER_MIN_INTERVAL_MS);
    quiet = true;
    expect(await run()).toEqual([]);
    quiet = false;
    expect(await run()).toEqual([card!.id]);
    expect(sent).toHaveLength(2);
  });

  it("does not record a reminder that could not be delivered", async () => {
    const h = setup();
    h.sync([{ kind: "ask-card", readable: true, items: [ask("q1")] }]);
    const [card] = h.repo.listOpen();
    h.repo.triage(card!.id, { remind_at: NOW }, "human:web", NOW);
    await runReminders({ repo: h.repo, now: h.now, isQuietHours: () => false, log, delivery: { deliver: async () => null } });
    expect(h.repo.reminders(card!.id)).toHaveLength(0);
    expect(h.repo.find(card!.id)?.remind_at).toBe(NOW);
  });
});
