import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DailyGoalRepository } from "./repository.js";
import { DailyGoalRunService, goalCardId } from "./service.js";
import type { DailyGoalLaunchInput, DailyGoalLaunchResult } from "./ports.js";
import type { EvidenceSnapshot, GoalActor } from "./domain.js";
import { readWorkMode } from "../work-modes/work-mode.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const at = (h: number, m = 0) => new Date(2026, 9, 10, h, m).getTime();
const actor = (patch: Partial<GoalActor> = {}): GoalActor => ({ platform: "discord", userId: "neco", guildId: "g", channelId: "c", isBot: false, isWebhook: false, role: null, ...patch });
const draft = {
  project: "Cc", goalText: "デイリーゴールを出荷する", acceptance: ["PR がマージされる", "Actio task が完了する"], actioTaskIds: ["t1"],
  permissions: { merge: false, test: true, service: false, deploy: false },
};

function harness() {
  const db = new Database(":memory:"); databases.push(db);
  const repo = new DailyGoalRepository(db);
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
    candidateProjects: [] as string[],
    launch: async (input: DailyGoalLaunchInput): Promise<DailyGoalLaunchResult> => {
      state.runs.set(input.runId, { id: input.runId, status: "running", childSessionId: null });
      return { ok: true, runId: input.runId };
    },
  };
  let seq = 0;
  const service = new DailyGoalRunService({
    repo,
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
    tasks: { activeTasks: async () => [{ id: "t9", title: "期限の近い task", status: "pending", dueAt: "2026-10-11" }] },
    config: () => ({ launchTime: "07:30", checkpointMinutes: 60, candidateProjects: state.candidateProjects }),
    baseUrl: "http://127.0.0.1:1",
    newId: () => `id-${++seq}`,
  });
  return { db, repo, service, state };
}

/** 確定 → 7:30 起動 → セッション紐付けまで進めた running ゴール。 */
async function runningGoal(h: ReturnType<typeof harness>) {
  const confirmed = h.service.confirmGoal({ draft, actor: actor(), receiptId: "i-1", now: at(6) });
  if (!confirmed.ok) throw new Error("confirm failed");
  await h.service.tick(at(7, 30));
  const run = [...h.state.runs.values()][0]!;
  run.childSessionId = "s1";
  h.state.sessions.set("s1", { status: "active", metadata: null });
  await h.service.tick(at(7, 31));
  return h.repo.byId(confirmed.goal.id)!;
}

describe("confirmation (CC-DG-INV-01)", () => {
  it("does not confirm an incomplete goal and names the missing fields", () => {
    const h = harness();
    const result = h.service.confirmGoal({ draft: { project: "Cc", goalText: "x" }, actor: actor(), receiptId: "i", now: at(6) });
    expect(result).toMatchObject({ ok: false, kind: "missing" });
    if (!result.ok && result.kind === "missing") expect(result.missing).toEqual(["acceptance", "actioTaskIds", "merge", "test", "service", "deploy"]);
    expect(h.repo.list()).toHaveLength(0);
  });

  it("rejects bots, unknown projects and merge permission from staff", () => {
    const h = harness();
    expect(h.service.confirmGoal({ draft, actor: actor({ isBot: true }), receiptId: "i", now: 1 })).toMatchObject({ ok: false, kind: "forbidden" });
    expect(h.service.confirmGoal({ draft: { ...draft, project: "Nope" }, actor: actor(), receiptId: "i", now: 1 })).toMatchObject({ ok: false, kind: "unknown_project" });
    expect(h.service.confirmGoal({ draft: { ...draft, permissions: { ...draft.permissions, merge: true } }, actor: actor(), receiptId: "i", now: 1 }))
      .toMatchObject({ ok: false, kind: "forbidden" });
  });

  it("treats a retried confirmation as the same goal", () => {
    const h = harness();
    const first = h.service.confirmGoal({ draft, actor: actor(), receiptId: "i-1", now: at(6) });
    const again = h.service.confirmGoal({ draft, actor: actor(), receiptId: "i-1", now: at(6, 1) });
    expect(first.ok && again.ok && first.goal.id === again.goal.id && !again.created).toBe(true);
  });
});

describe("launch (受け入れ基準: 本人の確定だけが起動し、同じゴールで 2 本目を起動しない)", () => {
  it("launches at 07:30 once, then binds the session with the goal and the work mode", async () => {
    const h = harness();
    h.service.confirmGoal({ draft, actor: actor(), receiptId: "i-1", now: at(6) });
    await h.service.tick(at(7, 29));
    expect(h.state.launches).toHaveLength(0);
    const goal = await runningGoal(h);
    await h.service.tick(at(7, 40));
    expect(h.state.launches).toHaveLength(1);
    expect(h.state.launches[0]).toMatchObject({ cwd: "E:/repo", project: "Concordia", args: { daily_goal_id: goal.id } });
    expect(goal).toMatchObject({ status: "running", sessionId: "s1" });
    const metadata = h.state.sessions.get("s1")!.metadata;
    expect(readWorkMode(metadata)).toMatchObject({ mode: "daily-goal-run", ref: goal.id });
    expect(JSON.parse(metadata!).goal.text).toContain(draft.goalText);
  });

  it("never re-invokes while the launch result is unknown, and reconciles from the run ledger", async () => {
    const h = harness();
    h.state.launch = async () => { throw new Error("timeout"); };
    h.service.confirmGoal({ draft, actor: actor(), receiptId: "i-1", now: at(6) });
    await h.service.tick(at(7, 30));
    await h.service.tick(at(8, 30));
    expect(h.state.launches).toHaveLength(1);
    const goal = h.repo.list()[0]!;
    expect(goal.launchState).toBe("unknown");
    h.state.runs.set(goal.runId!, { id: goal.runId!, status: "running", childSessionId: null });
    await h.service.tick(at(8, 31));
    expect(h.repo.byId(goal.id)).toMatchObject({ status: "running", launchState: "launched" });
    expect(h.state.launches).toHaveLength(1);
  });

  it("releases a definitely failed launch for a later retry only when no run exists", async () => {
    const h = harness();
    h.state.launch = async () => ({ ok: false, error: "template is inactive" });
    h.service.confirmGoal({ draft, actor: actor(), receiptId: "i-1", now: at(6) });
    await h.service.tick(at(7, 30));
    expect(h.repo.list()[0]).toMatchObject({ launchState: "none", status: "confirmed" });
    await h.service.tick(at(7, 35));
    expect(h.state.launches).toHaveLength(1);
    await h.service.tick(at(7, 41));
    expect(h.state.launches).toHaveLength(2);
  });
});

describe("checkpoints (受け入れ基準: 1 時間ごとに証跡・報告・判断点が同じカードで届き、予算が戻る)", () => {
  it("sends a progress check and resets the budget when evidence increased", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    h.state.evidence.items.push({ key: "commit:abc", kind: "commit", summary: "feat", at: at(8) });
    await h.service.tick(at(8, 31));
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
    await h.service.tick(at(8, 31));
    expect(h.state.injects.at(-1)?.text).toContain("完了確認");
    expect(h.state.resets).toEqual([]);
    expect(h.repo.byId(goal.id)?.status).toBe("running");
  });

  it("does not inject, reset or stop while waiting for an answer, and resumes afterwards", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    h.state.waiting = true;
    await h.service.tick(at(8, 31));
    await h.service.tick(at(9, 32));
    expect(h.state.injects).toEqual([]);
    expect(h.state.resets).toEqual([]);
    expect(h.repo.checkpoints(goal.id).map((cp) => cp.kind)).toEqual(["skipped_waiting", "skipped_waiting"]);
    expect(h.repo.timeline(goal.id).filter((t) => t.text.includes("回答待ち"))).toHaveLength(1);
    h.state.waiting = false;
    h.state.evidence.items.push({ key: "commit:def", kind: "commit", summary: "fix", at: null });
    await h.service.tick(at(10, 33));
    expect(h.state.resets).toEqual(["s1"]);
  });

  it("never stops on time or stagnation, even across the date change", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    for (let hour = 8; hour < 30; hour++) await h.service.tick(new Date(2026, 9, 10, hour, 31).getTime());
    expect(h.repo.byId(goal.id)?.status).toBe("running");
    expect(h.state.launches).toHaveLength(1);
  });
});

describe("stop conditions (受け入れ基準: 到達・十分にこなした・人間の停止の 3 つだけ)", () => {
  it("reaches only when Cc verified evidence for every acceptance item", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    h.state.evidence.items.push({ key: "pr:o#1:merged", kind: "pr", summary: "merged", at: null });
    const partial = await h.service.reportReached(goal.id, "s1", [
      { item: "PR がマージされる", refs: ["pr:o#1:merged"] },
      { item: "Actio task が完了する", refs: ["actio:t1:done"] },
    ], at(9));
    expect(partial).toMatchObject({ outcome: "go", missing: ["Actio task が完了する"], unverified: ["actio:t1:done"] });
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
    await h.service.tick(at(8, 31));
    const first = h.service.reportExhausted(goal.id, "s1", [{ item: "残りの実装", class: "doable" }], at(8, 40));
    expect(first).toEqual({ outcome: "go", doable: ["残りの実装"], budgetReset: true });
    const second = h.service.reportExhausted(goal.id, "s1", [{ item: "残りの実装", class: "doable" }], at(8, 45));
    expect(second).toMatchObject({ outcome: "go", budgetReset: false });
    expect(h.state.resets).toEqual(["s1"]);
    expect(h.repo.byId(goal.id)?.status).toBe("running");
  });

  it("accepts exhausted only with reasons and real human judgments, and carries the rest to tomorrow's candidate only", async () => {
    const h = harness();
    const goal = await runningGoal(h);
    // 当日の候補は起動前に用意済み (設定は空)。ここで設定し、やり切りの残りだけが翌日の候補になることを見る。
    h.state.candidateProjects = ["Concordia"];
    expect(h.service.reportExhausted(goal.id, "s1", [{ item: "判断", class: "human_judgment", questionId: 7 }], at(9))).toMatchObject({ outcome: "rejected" });
    h.state.unanswered.add(7);
    expect(h.service.reportExhausted(goal.id, "s1", [
      { item: "判断", class: "human_judgment", questionId: 7 },
      { item: "外部依存", class: "unachievable", reason: "相手サービスが停止中" },
    ], at(9, 1))).toEqual({ outcome: "exhausted" });
    expect(h.repo.byId(goal.id)).toMatchObject({ status: "exhausted", remaining: [{ item: "判断" }, { item: "外部依存" }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const tomorrow = h.repo.listByStatus(["confirmed", "running"]);
    expect(tomorrow).toHaveLength(0);
    const candidates = h.db.prepare("SELECT date FROM daily_goal_candidates").all() as Array<{ date: string }>;
    expect(candidates.map((c) => c.date)).toEqual(["2026-10-11"]);
  });

  it("stops only by the confirmer or a manager", async () => {
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

describe("candidates (受け入れ基準: やり切りの残りは翌朝の候補に出るが、ゴールには自動でならない)", () => {
  it("prepares a candidate card 30 minutes before launch only for configured projects", async () => {
    const h = harness();
    await h.service.tick(at(7, 0));
    expect(h.repo.candidate("x")).toBeNull();
    h.state.candidateProjects = ["Cc"];
    const fresh = harness();
    fresh.state.candidateProjects = ["Cc"];
    await fresh.service.tick(at(6, 59));
    expect(fresh.db.prepare("SELECT count(*) AS n FROM daily_goal_candidates").get()).toEqual({ n: 0 });
    await fresh.service.tick(at(7, 0));
    expect(fresh.db.prepare("SELECT count(*) AS n FROM daily_goal_candidates").get()).toEqual({ n: 1 });
    expect(fresh.repo.list()).toHaveLength(0);
    expect(fresh.state.launches).toHaveLength(0);
  });
});
