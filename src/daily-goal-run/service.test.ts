import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DailyGoalRepository } from "./repository.js";
import { DailyGoalDraftRepository } from "./draft-repository.js";
import { DailyGoalDayRepository } from "./day-repository.js";
import { DailyGoalAlertRepository } from "./alert-repository.js";
import { DailyGoalRunService, goalCardId } from "./service.js";
import { summaryCardId } from "./day-close.js";
import { reminderCardId } from "./reminder.js";
import type { EvidenceSnapshot, ExtractedGoal, GoalActor } from "./domain.js";
import type { ExtractionResult } from "./goal-extraction.js";
import type { JournalCallResult } from "./memoria-journal.js";
import type { JudgeInput, JudgeResult } from "./progress-judge.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const at = (h: number, m = 0) => new Date(2026, 9, 10, h, m).getTime();
const H = 60 * 60_000;
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

const judged = (verdict: string, acceptance: unknown[] = [], reason = "理由"): JudgeResult => ({ ok: true, raw: { verdict, reason, acceptance } });

function harness() {
  const db = new Database(":memory:"); databases.push(db);
  const repo = new DailyGoalRepository(db);
  const drafts = new DailyGoalDraftRepository(db);
  const days = new DailyGoalDayRepository(db);
  const alerts = new DailyGoalAlertRepository(db);
  const journal: Journal = { puts: [], notes: [], fail: "none", sections: new Set() };
  const state = {
    evidence: { items: [], taskStatuses: { t1: "pending" }, unavailable: [] } as EvidenceSnapshot,
    judgment: judged("on_track") as JudgeResult,
    judgeCalls: [] as JudgeInput[],
    extraction: { ok: false, error: "llm unavailable" } as ExtractionResult,
    extractions: 0,
  };
  const failure = <T>(): JournalCallResult<T> | null =>
    journal.fail === "none" ? null : { ok: false, kind: journal.fail, error: `memoria ${journal.fail}` };
  let seq = 0;
  const service = new DailyGoalRunService({
    repo, drafts, days, alerts,
    extraction: { extract: async () => { state.extractions++; return structuredClone(state.extraction); } },
    judge: { judge: async (input) => { state.judgeCalls.push(structuredClone(input)); return structuredClone(state.judgment); } },
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
    projects: { resolve: (v) => (v === "Cc" || v === "Concordia" ? { project: "Concordia", repoPath: "E:/repo" } : null) },
    config: () => ({ checkpointMinutes: 60, dayBoundary: "04:00", reminderTime: "09:00" }),
    newId: () => `id-${++seq}`,
  });
  return { db, repo, drafts, days, alerts, service, state, journal };
}

/** 投稿で登録した見守り中のゴール。 */
async function registeredGoal(h: ReturnType<typeof harness>, now = at(6)) {
  const result = await h.service.intake.intakePost({ text: POST, messageId: "m1", actor: actor(), now });
  if (result.kind !== "thread" || !result.goalId) throw new Error(`register failed: ${JSON.stringify(result)}`);
  await flush();
  return h.repo.byId(result.goalId)!;
}

describe("post intake (受け入れ基準: 投稿から 3 項目がそろえば登録 (セッションは起動しない)、欠ければスレッドで聞き返す)", () => {
  it("registers a structured post without the LLM and without launching a session, even before 07:30", async () => {
    const h = harness();
    const result = await h.service.intake.intakePost({ text: POST, messageId: "m1", actor: actor(), now: at(5) });
    expect(result).toMatchObject({ kind: "thread", threadId: null });
    if (result.kind !== "thread") return;
    expect(result.reply).toContain("登録しました");
    expect(result.reply).toContain("テスト=可");
    expect(h.state.extractions).toBe(0);
    expect(result.reply).toContain("1 時間ごとに進み具合を確認");
    expect(result.reply).not.toContain("専用セッション");
    await flush();
    expect(h.state.judgeCalls).toHaveLength(0);
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
  });

  it("records 目標なし for the business day", async () => {
    const h = harness();
    const result = await h.service.intake.intakePost({ text: "目標なしです", messageId: "m1", actor: actor(), now: new Date(2026, 9, 11, 2).getTime() });
    expect(result).toMatchObject({ kind: "reply" });
    expect(h.days.get("2026-10-10")).toMatchObject({ noGoalBy: "neco" });
  });
});

describe("one-shot checkpoints (受け入れ基準: 1 時間ごとに判定を 1 回だけ呼び、同じカードの更新で届く)", () => {
  it("judges once per hour from the registration with only the goal, acceptance, evidence and times", async () => {
    const h = harness();
    const goal = await registeredGoal(h);
    await h.service.tick(at(6, 59));
    expect(h.state.judgeCalls).toHaveLength(0);
    await h.service.tick(at(7));
    await h.service.tick(at(7, 30));
    expect(h.state.judgeCalls).toHaveLength(1);
    expect(h.state.judgeCalls[0]).toEqual({
      goalText: "デイリーゴールを出荷する", acceptance: ["PR がマージされる", "Actio task が完了する"],
      evidence: h.state.evidence, elapsedMinutes: 60, remainingMinutes: 21 * 60,
    });
    await h.service.tick(at(8));
    expect(h.state.judgeCalls).toHaveLength(2);
    const detail = h.service.detail(goal.id)!;
    expect(detail.checkpoints.map((cp) => cp.kind)).toEqual(["judgment", "judgment"]);
    expect(detail.checkpoints[0]!.judgment).toMatchObject({ verdict: "on_track" });
    expect(detail.timeline.at(-1)?.text).toContain("確認: 順調");
    expect(h.repo.card(goalCardId(goal.id))!.revision).toBeGreaterThan(1);
    expect(h.alerts.byGoal(goal.id)).toEqual([]);
  });

  it("notifies the poster only when poor, once per streak and once more after three hours", async () => {
    const h = harness();
    const goal = await registeredGoal(h);
    h.state.judgment = judged("behind", [{ index: 2, outlook: "at_risk", refs: [] }], "task が動いていない");
    await h.service.runCheckpoint(goal.id, at(7));
    await h.service.runCheckpoint(goal.id, at(8));
    h.state.judgment = judged("stalled");
    await h.service.runCheckpoint(goal.id, at(9));
    expect(h.alerts.byGoal(goal.id)).toHaveLength(1);
    expect(h.alerts.byGoal(goal.id)[0]).toMatchObject({ kind: "first", verdict: "behind", mentionUserId: "neco", status: "pending" });
    expect(h.alerts.byGoal(goal.id)[0]!.text).toContain("危うい: Actio task が完了する");
    await h.service.runCheckpoint(goal.id, at(10));
    await h.service.runCheckpoint(goal.id, at(11));
    expect(h.alerts.byGoal(goal.id).map((a) => a.kind)).toEqual(["first", "repeat"]);
    await h.service.runCheckpoint(goal.id, at(14));
    expect(h.alerts.byGoal(goal.id)).toHaveLength(2);

    h.state.judgment = judged("on_track");
    await h.service.runCheckpoint(goal.id, at(15));
    expect(h.repo.byId(goal.id)).toMatchObject({ alertCount: 0 });
    h.state.judgment = judged("behind");
    await h.service.runCheckpoint(goal.id, at(16));
    expect(h.alerts.byGoal(goal.id).map((a) => a.kind)).toEqual(["first", "repeat", "first"]);
    expect(h.repo.byId(goal.id)?.status).toBe("running");
  });

  it("records 判定できず without notifying or touching the streak, and tries again next time", async () => {
    const h = harness();
    const goal = await registeredGoal(h);
    h.state.judgment = judged("behind");
    await h.service.runCheckpoint(goal.id, at(7));
    h.state.judgment = { ok: false, error: "判定の実行に失敗しました (時間切れを含む)" };
    expect(await h.service.runCheckpoint(goal.id, at(8))).toBe("failed");
    h.state.judgment = judged("unknown-verdict");
    expect(await h.service.runCheckpoint(goal.id, at(9))).toBe("failed");
    expect(h.service.detail(goal.id)!.checkpoints.map((cp) => cp.kind)).toEqual(["judgment", "judge_failed", "judge_failed"]);
    expect(h.repo.byId(goal.id)).toMatchObject({ alertStreakSince: at(7), alertCount: 1 });
    expect(h.alerts.byGoal(goal.id)).toHaveLength(1);
    await h.service.tick(at(10));
    expect(h.state.judgeCalls).toHaveLength(4);
  });

  it("reaches only when every acceptance item is reached with existing evidence", async () => {
    const h = harness();
    const goal = await registeredGoal(h);
    h.state.judgment = judged("on_track", [
      { index: 1, outlook: "reached", refs: ["pr:o#1:merged"] }, { index: 2, outlook: "reached", refs: ["actio:t1:done"] },
    ]);
    expect(await h.service.runCheckpoint(goal.id, at(7))).toBe("on_track");
    expect(h.repo.byId(goal.id)?.status).toBe("running");
    h.state.evidence.items.push(
      { key: "pr:o#1:merged", kind: "pr", summary: "PR #1 merged", at: null },
      { key: "actio:t1:done", kind: "actio", summary: "Actio task t1 done", at: null },
    );
    expect(await h.service.runCheckpoint(goal.id, at(8))).toBe("reached");
    expect(h.repo.byId(goal.id)).toMatchObject({ status: "achieved", stopReason: "goal_reached",
      acceptanceProgress: { "PR がマージされる": ["pr:o#1:merged"], "Actio task が完了する": ["actio:t1:done"] } });
    expect(h.alerts.byGoal(goal.id)).toEqual([]);
    await h.service.tick(at(10));
    expect(h.state.judgeCalls).toHaveLength(2);
  });

  it("never stops on a poor verdict or at midnight", async () => {
    const h = harness();
    const goal = await registeredGoal(h);
    h.state.judgment = judged("stalled");
    for (let hour = 7; hour <= 27; hour++) await h.service.tick(at(6) + (hour - 6) * H);
    expect(h.repo.byId(goal.id)?.status).toBe("running");
  });
});

describe("stop conditions (受け入れ基準: 到達・人間の停止・締切の 3 つだけ)", () => {
  it("stops only by the poster or a manager and stops judging afterwards", async () => {
    const h = harness();
    const goal = await registeredGoal(h);
    expect(() => h.service.stopByHuman(goal.id, actor({ userId: "other" }), at(7))).toThrow();
    expect(() => h.service.stopByHuman(goal.id, actor({ userId: "other", isBot: true, role: "executive" }), at(7))).toThrow();
    expect(h.service.stopByHuman(goal.id, actor({ userId: "boss", role: "manager" }), at(7))).toMatchObject({ status: "stopped", stoppedBy: "boss" });
    expect(() => h.service.stopByHuman(goal.id, actor(), at(8))).toThrow();
    await h.service.tick(at(9));
    expect(h.state.judgeCalls).toHaveLength(0);
  });

  it("does not record a judgment for a goal stopped while the judge was running", async () => {
    const h = harness();
    const goal = await registeredGoal(h);
    h.state.judgment = judged("behind");
    const pending = h.service.runCheckpoint(goal.id, at(7));
    h.service.stopByHuman(goal.id, actor(), at(7));
    expect(await pending).toBe("not_active");
    expect(h.service.detail(goal.id)!.checkpoints).toEqual([]);
    expect(h.alerts.byGoal(goal.id)).toEqual([]);
  });

  it("keeps judging a legacy confirmed goal without touching its session", async () => {
    const h = harness();
    const goal = await registeredGoal(h);
    h.db.prepare("UPDATE daily_goals SET status='confirmed', session_id='s-old' WHERE id=?").run(goal.id);
    await h.service.tick(at(7));
    expect(h.state.judgeCalls).toHaveLength(1);
    expect(h.repo.byId(goal.id)).toMatchObject({ status: "confirmed", sessionId: "s-old" });
  });
});

describe("alert delivery target (5. スレッドがあればスレッド、無ければカード)", () => {
  it("points to the goal thread, or to the delivered card when there is no thread", async () => {
    const h = harness();
    const goal = await registeredGoal(h);
    h.state.judgment = judged("behind");
    await h.service.runCheckpoint(goal.id, at(7));
    const alert = h.alerts.byGoal(goal.id)[0]!;
    expect(h.service.alertContent(alert)).toMatchObject({ mentionUserId: "neco", threadId: null, cardMessageId: null });
    h.service.cardDelivered(goalCardId(goal.id), 1, "ch", "card-1", at(7));
    expect(h.service.alertContent(alert)).toMatchObject({ threadId: null, cardMessageId: "card-1" });
    h.service.intake.attachThread(h.drafts.bySourceMessage("m1")!.id, "th1", at(7));
    expect(h.service.alertContent(alert)).toMatchObject({ threadId: "th1" });
  });
});

describe("deadline and day summary (受け入れ基準: 4:00 に締切で止まり、日記の節 1 つ・ノート 1 本に記載され、再実行しても増えない)", () => {
  const nextDay = (h: number, m = 0) => new Date(2026, 9, 11, h, m).getTime();

  it("stops running goals at 4:00, summarizes, writes the diary and note once and posts the summary", async () => {
    const h = harness();
    const goal = await registeredGoal(h);
    h.state.evidence.items.push({ key: "pr:o#1:merged", kind: "pr", summary: "PR #1 merged", at: null });
    h.state.judgment = judged("behind", [{ index: 1, outlook: "reached", refs: ["pr:o#1:merged"] }], "task が残っている");
    await h.service.tick(nextDay(3, 59));
    expect(h.repo.byId(goal.id)?.status).toBe("running");
    await h.service.tick(nextDay(4));
    expect(h.repo.byId(goal.id)).toMatchObject({ status: "deadline", stopReason: "deadline", acceptanceProgress: { "PR がマージされる": ["pr:o#1:merged"] } });
    const day = h.days.get("2026-10-10")!;
    expect(day).toMatchObject({ closeState: "journaled", diaryState: "written", noteState: "written", noteId: "n1" });
    expect(day.summaryMarkdown).toContain("結果: **締切**");
    expect(day.summaryMarkdown).toContain("#### 最後の判定\n- 遅れ気味: task が残っている");
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
    await registeredGoal(h);
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
    await registeredGoal(h);
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
    await registeredGoal(h);
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
