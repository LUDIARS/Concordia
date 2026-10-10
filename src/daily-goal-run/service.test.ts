import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DailyGoalRepository } from "./repository.js";
import { DailyGoalDraftRepository } from "./draft-repository.js";
import { DailyGoalDayRepository } from "./day-repository.js";
import { DailyGoalRunService, goalCardId } from "./service.js";
import { summaryCardId } from "./day-close.js";
import { reminderCardId } from "./reminder.js";
import type { DailyGoalLaunchInput, DailyGoalLaunchResult } from "./ports.js";
import type { EvidenceSnapshot, ExtractedGoal, GoalActor } from "./domain.js";
import type { ExtractionResult } from "./goal-extraction.js";
import type { JournalCallResult } from "./memoria-journal.js";
import { readWorkMode } from "../work-modes/work-mode.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const at = (h: number, m = 0) => new Date(2026, 9, 10, h, m).getTime();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const actor = (patch: Partial<GoalActor> = {}): GoalActor => ({ platform: "discord", userId: "neco", guildId: "g", channelId: "c", isBot: false, isWebhook: false, role: null, ...patch });
const POST = [
  "プロジェクト: Cc",
  "ゴール: デイリーゴールを出荷する",
  "受入条件:",
  "- PR がマージされる",
  "- Actio task が完了する",
  "許可: テスト",
  "task: t1",
].join("\n");

type Journal = { puts: Array<{ date: string; source: string }>; notes: Array<{ external_id: string }>; fail: "none" | "rejected" | "unknown"; sections: Set<string> };

function harness() {
  const db = new Database(":memory:"); databases.push(db);
  const repo = new DailyGoalRepository(db);
  const drafts = new DailyGoalDraftRepository(db);
  const days = new DailyGoalDayRepository(db);
  const journal: Journal = { puts: [], notes: [], fail: "none", sections: new Set() };
  const state = {
    waiting: false,
    evidence: { items: [], taskStatuses: { t1: "pending" }, unavailable: [] } as EvidenceSnapshot,
    injects: [] as Array<{ sessionId: string; text: string }>,
    resets: [] as string[],
    disabled: [] as string[],
    launches: [] as DailyGoalLaunchInput[],
    runs: new Map<string, { id: string; status: string; childSessionId: string | null }>(),
    sessions: new Map<string, { status: string; metadata: string | null }>(),
    unanswered: new Set<number>(),
    extraction: { ok: false, error: "llm unavailable" } as ExtractionResult,
    extractions: 0,
    launch: async (input: DailyGoalLaunchInput): Promise<DailyGoalLaunchResult> => {
      state.runs.set(input.runId, { id: input.runId, status: "running", childSessionId: null });
      return { ok: true, runId: input.runId };
    },
  };
  const failure = <T>(): JournalCallResult<T> | null =>
    journal.fail === "none" ? null : { ok: false, kind: journal.fail, error: `memoria ${journal.fail}` };
  let seq = 0;
  const service = new DailyGoalRunService({
    repo, drafts, days,
    extraction: { extract: async () => { state.extractions++; return structuredClone(state.extraction); } },
    journal: {
      putDiarySection: async (date, source) => {
        const failed = failure<{ url?: string }>();
        if (failed) return failed;
        journal.puts.push({ date, source });
        journal.sections.add(date);
        return { ok: true, value: {} };
      },
      getDiarySection: async (date) => ({ ok: true, value: { exists: journal.sections.has(date) } }),
      createNote: async (input) => {
        const failed = failure<{ id: string }>();
        if (failed) return failed;
        if (!journal.notes.some((n) => n.external_id === input.external_id)) journal.notes.push({ external_id: input.external_id });
        return { ok: true, value: { id: "n1", url: "http://memoria/notes/n1" } };
      },
    },
    evidence: { collect: async () => structuredClone(state.evidence) },
    delegation: {
      launch: (input) => { state.launches.push(input); return state.launch(input); },
      findRun: (id) => state.runs.get(id) ?? null,
    },
    sessions: {
      find: (id) => { const s = state.sessions.get(id); return s ? { id, ...s } : null; },
      updateMetadata: (id, update) => { const s = state.sessions.get(id); if (s) s.metadata = update(s.metadata); },
    },
    waiting: {
      isWaiting: () => state.waiting,
      isUnansweredQuestion: (_s, q) => state.unanswered.has(q),
      isHumanWaitActive: () => state.waiting,
    },
    autonomy: { resetBudget: (id) => state.resets.push(id), disable: (id) => state.disabled.push(id) },
    inject: { inject: (sessionId, text) => state.injects.push({ sessionId, text }) },
    projects: { resolve: (v) => (v === "Cc" || v === "Concordia" ? { project: "Concordia", repoPath: "E:/repo" } : null) },
    config: () => ({ checkpointMinutes: 60, dayBoundary: "04:00", reminderTime: "09:00" }),
    baseUrl: "http://127.0.0.1:1",
    newId: () => `id-${++seq}`,
  });
  return { db, repo, drafts, days, service, state, journal };
}

/** 投稿で登録 → その場で起動 → セッション紐付けまで進めた running ゴール。 */
async function runningGoal(h: ReturnType<typeof harness>, now = at(6)) {
  const result = await h.service.intake.intakePost({ text: POST, messageId: "m1", actor: actor(), now });
  if (result.kind !== "thread" || !result.goalId) throw new Error(`register failed: ${JSON.stringify(result)}`);
  await flush();
  const run = [...h.state.runs.values()][0]!;
  run.childSessionId = "s1";
  h.state.sessions.set("s1", { status: "active", metadata: null });
  await h.service.tick(now + 60_000);
  return h.repo.byId(result.goalId)!;
}

describe("post intake (受け入れ基準: 投稿から 3 項目がそろえばその場で起動、欠ければスレッドで聞き返す)", () => {
  it("registers a structured post without the LLM and launches immediately, even before 07:30", async () => {
    const h = harness();
    const result = await h.service.intake.intakePost({ text: POST, messageId: "m1", actor: actor(), now: at(5) });
    expect(result).toMatchObject({ kind: "thread", threadId: null });
    if (result.kind !== "thread") return;
    expect(result.reply).toContain("登録しました");
    expect(result.reply).toContain("テスト=可");
    expect(h.state.extractions).toBe(0);
    await flush();
    expect(h.state.launches).toHaveLength(1);
    expect(h.state.launches[0]).toMatchObject({ cwd: "E:/repo", project: "Concordia", args: { daily_goal_id: result.goalId, actio_tasks: "actio:t1" } });
    expect(h.state.launches[0]!.args.deadline).toContain("10/11 04:00");
    expect(h.repo.byId(result.goalId!)).toMatchObject({ date: "2026-10-10", sourceMessageId: "m1", status: "running" });
    expect(h.drafts.bySourceMessage("m1")).toMatchObject({ status: "registered", goalId: result.goalId });
  });

  it("asks for the missing fields in the thread and registers when the poster replies", async () => {
    const h = harness();
    const first = await h.service.intake.intakePost({ text: "プロジェクト: Cc\nゴール: 出荷する", messageId: "m1", actor: actor(), now: at(10) });
    expect(first).toMatchObject({ kind: "thread", threadId: null });
    if (first.kind !== "thread") return;
    expect(first.reply).toContain("受入条件");
    expect(first.reply).toContain("何がそろったら達成としますか");
    expect(h.repo.list()).toHaveLength(0);
    h.service.intake.attachThread(first.draftId, "th1", at(10));
    expect(await h.service.intake.supplementDraft({ threadId: "th1", text: "受入条件: PR がマージされる", actor: actor({ userId: "other" }), now: at(10, 5) }))
      .toEqual({ kind: "ignored" });
    const second = await h.service.intake.supplementDraft({ threadId: "th1", text: "受入条件: PR がマージされる", actor: actor(), now: at(10, 6) });
    expect(second).toMatchObject({ kind: "thread", threadId: "th1" });
    expect(h.repo.list()).toHaveLength(1);
    expect(h.repo.list()[0]!.acceptance).toEqual(["PR がマージされる"]);
  });

  it("re-reads an edited post while it is a draft, but never rewrites a registered goal", async () => {
    const h = harness();
    await h.service.intake.intakePost({ text: "ゴール: 出荷する", messageId: "m1", actor: actor(), now: at(10) });
    expect(await h.service.intake.postEdited({ text: "プロジェクト: Cc\nゴール: 出荷する\n受入条件: PR がマージされる", messageId: "m1", actor: actor(), now: at(10, 2) }))
      .toMatchObject({ kind: "thread" });
    expect(h.repo.list()).toHaveLength(1);
    expect(await h.service.intake.postEdited({ text: POST, messageId: "m1", actor: actor(), now: at(10, 3) })).toEqual({ kind: "ignored" });
    expect(h.repo.list()[0]!.goalText).toBe("出荷する");
  });

  it("never invents acceptance criteria from an LLM reading and drops ungrounded permissions", async () => {
    const h = harness();
    const text = "Cc の投稿登録を出荷したい。マージもしてよい";
    const raw: ExtractedGoal = {
      project: "Cc", goalText: "投稿登録を出荷する", acceptance: ["PR がマージされる"],
      permissions: { merge: true, test: true, service: false, deploy: false }, actioTaskIds: [],
      quotes: { project: "Cc", goalText: "投稿登録を出荷したい", "acceptance.0": "PR がマージされる", "permissions.merge": "マージもしてよい" },
    };
    h.state.extraction = { ok: true, extracted: raw };
    const result = await h.service.intake.intakePost({ text, messageId: "m1", actor: actor(), now: at(10) });
    expect(h.state.extractions).toBe(1);
    expect(result).toMatchObject({ kind: "thread" });
    if (result.kind === "thread") expect(result.reply).toContain("受入条件 (何がそろったら達成か)");
    expect(h.repo.list()).toHaveLength(0);
    expect(h.drafts.bySourceMessage("m1")?.extracted?.permissions).toEqual({ merge: true, test: false, service: false, deploy: false });
  });

  it("drops merge/deploy beyond the poster's role and tells so in the thread", async () => {
    const h = harness();
    const result = await h.service.intake.intakePost({ text: POST.replace("許可: テスト", "許可: マージ, 反映"), messageId: "m1", actor: actor(), now: at(10) });
    if (result.kind !== "thread") throw new Error("expected thread");
    expect(result.reply).toContain("マージ・反映 の許可は不可にしました");
    expect(h.repo.list()[0]!.permissions).toEqual({ merge: false, test: false, service: false, deploy: false });
  });

  it("does not register when the reading fails and guides the structured format", async () => {
    const h = harness();
    const result = await h.service.intake.intakePost({ text: "今日は Cc のバグを直す", messageId: "m1", actor: actor(), now: at(10) });
    if (result.kind !== "thread") throw new Error("expected thread");
    expect(result.reply).toContain("読み取りに失敗しました");
    expect(result.reply).toContain("プロジェクト: Cc");
    expect(h.repo.list()).toHaveLength(0);
  });

  it("creates one goal per post even when the post is redelivered, and ignores bots", async () => {
    const h = harness();
    await h.service.intake.intakePost({ text: POST, messageId: "m1", actor: actor(), now: at(10) });
    expect(await h.service.intake.intakePost({ text: POST, messageId: "m1", actor: actor(), now: at(10, 1) })).toEqual({ kind: "ignored" });
    expect(await h.service.intake.intakePost({ text: POST, messageId: "m2", actor: actor({ isBot: true }), now: at(10, 1) })).toEqual({ kind: "ignored" });
    await flush();
    expect(h.repo.list()).toHaveLength(1);
    expect(h.state.launches).toHaveLength(1);
  });

  it("records 目標なし for the business day", async () => {
    const h = harness();
    const result = await h.service.intake.intakePost({ text: "目標なしです", messageId: "m1", actor: actor(), now: new Date(2026, 9, 11, 2).getTime() });
    expect(result).toMatchObject({ kind: "reply" });
    expect(h.days.get("2026-10-10")).toMatchObject({ noGoalBy: "neco" });
  });
});

describe("launch (受け入れ基準: 同じゴールで 2 本目を起動しない)", () => {
  it("launches once, then binds the session with the goal and the work mode", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    await h.service.tick(at(6, 10));
    expect(h.state.launches).toHaveLength(1);
    expect(goal).toMatchObject({ status: "running", sessionId: "s1" });
    const metadata = h.state.sessions.get("s1")!.metadata;
    expect(readWorkMode(metadata)).toMatchObject({ mode: "daily-goal-run", ref: goal.id });
    expect(JSON.parse(metadata!).goal.text).toContain("デイリーゴールを出荷する");
  });

  it("never re-invokes while the launch result is unknown, and reconciles from the run ledger", async () => {
    const h = harness();
    h.state.launch = async () => { throw new Error("timeout"); };
    await h.service.intake.intakePost({ text: POST, messageId: "m1", actor: actor(), now: at(6) });
    await flush();
    await h.service.tick(at(7));
    expect(h.state.launches).toHaveLength(1);
    const goal = h.repo.list()[0]!;
    expect(goal.launchState).toBe("unknown");
    h.state.runs.set(goal.runId!, { id: goal.runId!, status: "running", childSessionId: null });
    await h.service.tick(at(7, 1));
    expect(h.repo.byId(goal.id)).toMatchObject({ status: "running", launchState: "launched" });
    expect(h.state.launches).toHaveLength(1);
  });

  it("releases a definitely failed launch for a later retry only when no run exists", async () => {
    const h = harness();
    h.state.launch = async () => ({ ok: false, error: "template is inactive" });
    await h.service.intake.intakePost({ text: POST, messageId: "m1", actor: actor(), now: at(6) });
    await flush();
    expect(h.repo.list()[0]).toMatchObject({ launchState: "none", status: "confirmed" });
    await h.service.tick(at(6, 5));
    expect(h.state.launches).toHaveLength(1);
    await h.service.tick(at(6, 11));
    expect(h.state.launches).toHaveLength(2);
  });
});

describe("checkpoints (受け入れ基準: 1 時間ごとに証跡・報告・判断点が同じカードで届き、予算が戻る)", () => {
  it("sends a progress check and resets the budget when evidence increased", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    h.state.evidence.items.push({ key: "commit:abc", kind: "commit", summary: "feat", at: at(7) });
    await h.service.tick(at(7, 2));
    expect(h.state.injects.at(-1)?.text).toContain("進捗確認");
    expect(h.state.resets).toEqual(["s1"]);
    const detail = h.service.detail(goal.id)!;
    expect(detail.checkpoints.at(-1)).toMatchObject({ kind: "progress", progress: true });
    expect(detail.card?.revision).toBeGreaterThan(1);
    expect(h.repo.card(goalCardId(goal.id))?.kind).toBe("goal");
  });

  it("sends a completion check without stopping and without resetting the budget when there is no progress", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    await h.service.tick(at(7, 2));
    expect(h.state.injects.at(-1)?.text).toContain("完了確認");
    expect(h.state.resets).toEqual([]);
    expect(h.repo.byId(goal.id)?.status).toBe("running");
  });

  it("does not inject, reset or stop while waiting for an answer, and resumes afterwards", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    h.state.waiting = true;
    await h.service.tick(at(7, 2));
    await h.service.tick(at(8, 3));
    expect(h.state.injects).toEqual([]);
    expect(h.state.resets).toEqual([]);
    expect(h.repo.checkpoints(goal.id).map((cp) => cp.kind)).toEqual(["skipped_waiting", "skipped_waiting"]);
    expect(h.repo.timeline(goal.id).filter((t) => t.text.includes("回答待ち"))).toHaveLength(1);
    h.state.waiting = false;
    h.state.evidence.items.push({ key: "commit:def", kind: "commit", summary: "fix", at: null });
    await h.service.tick(at(9, 4));
    expect(h.state.resets).toEqual(["s1"]);
  });

  it("never stops on stagnation or at midnight, only at the 4:00 deadline", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    for (let hour = 7; hour < 28; hour++) await h.service.tick(new Date(2026, 9, 10, hour, 2).getTime());
    expect(h.repo.byId(goal.id)?.status).toBe("running");
    expect(h.state.launches).toHaveLength(1);
  });
});

describe("stop conditions (受け入れ基準: 到達・十分にこなした・人間の停止・締切の 4 つだけ)", () => {
  it("reaches only when Cc verified evidence for every acceptance item", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    h.state.evidence.items.push({ key: "pr:o#1:merged", kind: "pr", summary: "merged", at: null });
    const partial = await h.service.reportReached(goal.id, "s1", [
      { item: "PR がマージされる", refs: ["pr:o#1:merged"] },
      { item: "Actio task が完了する", refs: ["actio:t1:done"] },
    ], at(9));
    expect(partial).toMatchObject({ outcome: "go", missing: ["Actio task が完了する"], unverified: ["actio:t1:done"] });
    expect(h.repo.byId(goal.id)?.acceptanceProgress).toEqual({ "PR がマージされる": ["pr:o#1:merged"], "Actio task が完了する": [] });
    h.state.evidence.items.push({ key: "actio:t1:done", kind: "actio", summary: "done", at: null });
    expect(await h.service.reportReached(goal.id, "s1", [
      { item: "PR がマージされる", refs: ["pr:o#1:merged"] }, { item: "Actio task が完了する", refs: ["actio:t1:done"] },
    ], at(9, 5))).toEqual({ outcome: "reached" });
    expect(h.repo.byId(goal.id)).toMatchObject({ status: "achieved", stopReason: "goal_reached" });
    expect(h.state.disabled).toEqual(["s1"]);
    expect(readWorkMode(h.state.sessions.get("s1")!.metadata)).toBeNull();
  });

  it("rejects reports from another session", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    await expect(h.service.reportReached(goal.id, "other", [], at(9))).rejects.toThrow();
    expect(() => h.service.reportExhausted(goal.id, "other", [], at(9))).toThrow();
  });

  it("refuses exhausted while doable work remains and resets the budget once for the open completion check", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    await h.service.tick(at(7, 2));
    const first = h.service.reportExhausted(goal.id, "s1", [{ item: "残りの実装", class: "doable" }], at(7, 10));
    expect(first).toEqual({ outcome: "go", doable: ["残りの実装"], budgetReset: true });
    const second = h.service.reportExhausted(goal.id, "s1", [{ item: "残りの実装", class: "doable" }], at(7, 15));
    expect(second).toMatchObject({ outcome: "go", budgetReset: false });
    expect(h.state.resets).toEqual(["s1"]);
    expect(h.repo.byId(goal.id)?.status).toBe("running");
  });

  it("accepts exhausted only with reasons and real human judgments, and does not carry the rest to another goal", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    expect(h.service.reportExhausted(goal.id, "s1", [{ item: "判断", class: "human_judgment", questionId: 7 }], at(9))).toMatchObject({ outcome: "rejected" });
    h.state.unanswered.add(7);
    expect(h.service.reportExhausted(goal.id, "s1", [
      { item: "判断", class: "human_judgment", questionId: 7 },
      { item: "外部依存", class: "unachievable", reason: "相手サービスが停止中" },
    ], at(9, 1))).toEqual({ outcome: "exhausted" });
    expect(h.repo.byId(goal.id)).toMatchObject({ status: "exhausted", remaining: [{ item: "判断" }, { item: "外部依存" }] });
    await h.service.tick(new Date(2026, 9, 11, 9).getTime());
    expect(h.repo.listByStatus(["confirmed", "running"])).toHaveLength(0);
  });

  it("stops only by the poster or a manager", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    expect(() => h.service.stopByHuman(goal.id, actor({ userId: "someone" }), at(9))).toThrow();
    expect(() => h.service.stopByHuman(goal.id, actor({ isBot: true }), at(9))).toThrow();
    expect(h.service.stopByHuman(goal.id, actor({ userId: "boss", role: "manager" }), at(9))).toMatchObject({ status: "stopped", stoppedBy: "boss" });
    await h.service.tick(at(10, 31));
    expect(h.state.resets).toEqual([]);
    expect(h.state.injects.at(-1)?.text).toContain("停止");
  });

  it("marks a lost session and never launches a replacement", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    h.service.onSessionLost("s1", at(9));
    await h.service.tick(at(10));
    expect(h.repo.byId(goal.id)).toMatchObject({ status: "lost", stopReason: "session_lost" });
    expect(h.state.launches).toHaveLength(1);
  });
});

describe("deadline and day summary (受け入れ基準: 4:00 に締切で止まり、日記の節 1 つ・ノート 1 本に記載され、再実行しても増えない)", () => {
  const nextDay = (h: number, m = 0) => new Date(2026, 9, 11, h, m).getTime();

  it("stops running goals at 4:00, summarizes, writes the diary and note once and posts the summary", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    h.state.evidence.items.push({ key: "pr:o#1:merged", kind: "pr", summary: "PR #1 merged", at: null });
    await h.service.reportReached(goal.id, "s1", [{ item: "PR がマージされる", refs: ["pr:o#1:merged"] }], at(20));
    await h.service.tick(nextDay(3, 59));
    expect(h.repo.byId(goal.id)?.status).toBe("running");
    await h.service.tick(nextDay(4));
    expect(h.repo.byId(goal.id)).toMatchObject({ status: "deadline", stopReason: "deadline", acceptanceProgress: { "PR がマージされる": ["pr:o#1:merged"] } });
    expect(h.state.injects.at(-1)?.text).toContain("締切");
    const day = h.days.get("2026-10-10")!;
    expect(day).toMatchObject({ closeState: "journaled", diaryState: "written", noteState: "written", noteId: "n1" });
    expect(day.summaryMarkdown).toContain("結果: **締切**");
    expect(h.journal.puts).toEqual([{ date: "2026-10-10", source: "concordia-daily-goal" }]);
    expect(h.journal.notes).toEqual([{ external_id: "concordia-daily-goal:2026-10-10" }]);
    expect(h.repo.card(summaryCardId("2026-10-10"))).toMatchObject({ kind: "summary" });
    h.service.cardDelivered(summaryCardId("2026-10-10"), 1, "ch", "msg", nextDay(4, 1));
    expect(h.days.get("2026-10-10")?.closeState).toBe("posted");
    await h.service.tick(nextDay(5));
    expect(h.journal.puts).toHaveLength(1);
    expect(h.journal.notes).toHaveLength(1);
  });

  it("keeps the summary unwritten when Memoria is unavailable and retries later without failing", async () => {
    const h = harness();
    await runningGoal(h);
    h.journal.fail = "rejected";
    await h.service.tick(nextDay(4));
    expect(h.days.get("2026-10-10")).toMatchObject({ closeState: "journaled", diaryState: "unwritten", noteState: "unwritten" });
    h.journal.fail = "none";
    await h.service.tick(nextDay(4, 2));
    expect(h.journal.puts).toHaveLength(0);
    await h.service.tick(nextDay(4, 6));
    expect(h.days.get("2026-10-10")).toMatchObject({ diaryState: "written", noteState: "written" });
  });

  it("reconciles an unknown diary write before resending", async () => {
    const h = harness();
    await runningGoal(h);
    h.journal.fail = "unknown";
    await h.service.tick(nextDay(4));
    expect(h.days.get("2026-10-10")?.diaryState).toBe("unknown");
    h.journal.fail = "none";
    h.journal.sections.add("2026-10-10");
    await h.service.tick(nextDay(4, 6));
    expect(h.days.get("2026-10-10")?.diaryState).toBe("written");
    expect(h.journal.puts).toHaveLength(0);
  });

  it("writes nothing on a no-goal day and only the drafts on a draft-only day", async () => {
    const h = harness();
    await h.service.intake.intakePost({ text: "目標なし", messageId: "m0", actor: actor(), now: at(8) });
    await h.service.tick(nextDay(4));
    expect(h.days.get("2026-10-10")).toMatchObject({ closeState: "skipped" });
    expect(h.journal.puts).toHaveLength(0);

    const other = harness();
    await other.service.intake.intakePost({ text: "ゴール: 調べる", messageId: "m1", actor: actor(), now: at(8) });
    await other.service.tick(nextDay(4));
    expect(other.drafts.bySourceMessage("m1")?.status).toBe("expired");
    expect(other.days.get("2026-10-10")?.summaryMarkdown).toContain("未定義のまま締切");
    expect(other.journal.puts).toHaveLength(1);
  });

  it("lets only a manager resend the summary by hand", async () => {
    const h = harness();
    await runningGoal(h);
    await h.service.tick(nextDay(4));
    await expect(h.service.resendSummary("2026-10-10", actor(), nextDay(5))).rejects.toThrow();
    const day = await h.service.resendSummary("2026-10-10", actor({ role: "manager" }), nextDay(5));
    expect(day).toMatchObject({ diaryState: "written", noteState: "written" });
    expect(h.journal.puts).toHaveLength(2);
    expect(h.journal.notes).toHaveLength(1);
  });
});

describe("9:00 reminder (受け入れ基準: 目標の無い日は 1 回だけ通知し、目標なしの日は通知しない)", () => {
  it("queues one reminder at 09:00 on an empty day", async () => {
    const h = harness();
    await h.service.tick(at(8, 59));
    expect(h.repo.card(reminderCardId("2026-10-10"))).toBeNull();
    await h.service.tick(at(9));
    await h.service.tick(at(10));
    expect(h.repo.card(reminderCardId("2026-10-10"))).toMatchObject({ kind: "reminder", revision: 1 });
    h.service.cardDelivered(reminderCardId("2026-10-10"), 1, "ch", "r1", at(9, 1));
    expect(h.days.get("2026-10-10")).toMatchObject({ reminderState: "posted", reminderMessageId: "r1" });
  });

  it("does not notify on a no-goal day or a day with a draft", async () => {
    const h = harness();
    await h.service.intake.intakePost({ text: "目標なし", messageId: "m0", actor: actor(), now: at(8) });
    await h.service.tick(at(9));
    expect(h.repo.card(reminderCardId("2026-10-10"))).toBeNull();
    const other = harness();
    await other.service.intake.intakePost({ text: "ゴール: 調べる", messageId: "m1", actor: actor(), now: at(8) });
    await other.service.tick(at(9));
    expect(other.repo.card(reminderCardId("2026-10-10"))).toBeNull();
  });
});
