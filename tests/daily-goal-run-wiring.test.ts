/**
 * デイリーゴール自走の配線テスト (spec/feature/daily-goal-run.md — 受け入れ基準)。
 *
 * composition root (bootstrap/daily-goal-run.ts) を実 DB の repo で組み、 投稿 → 登録 → その場で起動 → 紐付け →
 * 確認の inject → 回答待ちの抑止 → 停止 までを通す。 外部プロセス (delegation の spawn・git・Actio・LLM・Memoria) は fake。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { PrRecordsRepo } from "../src/db/pr-records-repo.js";
import { ProjectCodesRepo } from "../src/db/project-codes-repo.js";
import { makeDiscordPendingQuestionsRepo } from "../src/db/discord-repo.js";
import { StaffRepo } from "../src/db/staff-repo.js";
import { eventBus, type ConcordiaEvent } from "../src/events.js";
import { createDailyGoalRuntime } from "../src/bootstrap/daily-goal-run.js";
import { readGoalAndGoStatus } from "../src/control/goal-and-go.js";
import { readWorkMode } from "../src/work-modes/work-mode.js";
import { commandNamesForRegistration } from "../src/discord/commands.js";
import { workflowForCommand } from "../src/discord/command-workflow.js";
import { WORKFLOW_KEYS, workflowDefaultEnabled } from "../src/workflow/keys.js";
import { SETTING_DEFINITIONS } from "../src/config/settings/definitions/index.js";
import type { InvokeInput } from "../src/delegation/contracts.js";

/** 投稿の時刻 (業務日 2026-10-10 の 10:00)。 tick はここから分単位で進める (締切は 10/11 04:00)。 */
const POSTED_AT = new Date(2026, 9, 10, 10, 0).getTime();
const sinceConfirm = (_confirmedAt: number, minutes: number) => POSTED_AT + minutes * 60_000;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const unsubscribers: Array<() => void> = [];
afterEach(() => { for (const off of unsubscribers.splice(0)) off(); vi.useRealTimers(); });

function setup() {
  const db = makeTestDb();
  const sessions = new SessionsRepo(db);
  const projectCodes = new ProjectCodesRepo(db);
  projectCodes.register({ code: "Cc", project: "Concordia", repoPath: "E:/Document/Ars/Concordia", repoOrigin: null, addedBy: "test" });
  const pendingQuestions = makeDiscordPendingQuestionsRepo(db);
  const invocations: InvokeInput[] = [];
  const runs = new Map<string, { id: string; status: string; child_session_id: string | null }>();
  const settings = new Map<string, string>();
  const runtime = createDailyGoalRuntime({
    db, sessions, prs: new PrRecordsRepo(db), projectCodes, pendingQuestions, staff: new StaffRepo(db),
    delegationRepo: { findRun: (id: string) => (runs.get(id) ?? null) as never },
    delegationService: {
      invoke: async (input: InvokeInput) => {
        invocations.push(input);
        const run = { id: input.reserved_run_id!, status: "running", child_session_id: null };
        runs.set(run.id, run);
        return { ok: true, run } as never;
      },
    },
    taskStore: () => ({ findByRelativePath: async () => ({ status: "pending" }), findForProject: async () => [] }) as never,
    settings: { get: (key: string) => settings.get(key) ?? null },
    isEnabled: () => true,
    baseUrl: "http://127.0.0.1:11111",
    extraction: { extract: async () => ({ ok: false as const, error: "llm unavailable" }) },
    journal: {
      putDiarySection: async () => ({ ok: false as const, kind: "rejected" as const, error: "memoria responded 404" }),
      getDiarySection: async () => ({ ok: true as const, value: { exists: false } }),
      createNote: async () => ({ ok: false as const, kind: "rejected" as const, error: "memoria responded 404" }),
    },
    log: { info: () => undefined, warn: () => undefined },
  });
  const injects: Array<Extract<ConcordiaEvent, { type: "session.inject" }>> = [];
  unsubscribers.push(eventBus.subscribe((event) => { if (event.type === "session.inject") injects.push(event); }));
  return { db, sessions, pendingQuestions, runtime, invocations, runs, injects };
}

const actor = { userId: "neco", guildId: "g", channelId: "c", isBot: false, isWebhook: false };
const POST = ["プロジェクト: Cc", "ゴール: デイリーゴール自走を出荷する", "受入条件: PR がマージされる", "task: t1"].join("\n");

/** 投稿で登録する (登録した直後に起動まで進む)。 */
async function register(env: ReturnType<typeof setup>, messageId = "m1") {
  vi.setSystemTime(POSTED_AT);
  const result = await env.runtime.surface.intake.post({ text: POST, messageId, actor });
  await flush();
  if (result.kind !== "thread" || !result.goalId) throw new Error(`register failed: ${JSON.stringify(result)}`);
  return env.runtime.service.detail(result.goalId)!.goal;
}

describe("daily-goal-run wiring", () => {
  it("registers the workflow toggle and settings, without /co-daily-goal, the launch time or candidates (撤廃)", () => {
    expect(commandNamesForRegistration()).not.toContain("co-daily-goal");
    expect(workflowForCommand("co-daily-goal")).toBeNull();
    expect(WORKFLOW_KEYS).toContain("daily_goal");
    expect(workflowDefaultEnabled("daily_goal")).toBe(true);
    const keys = SETTING_DEFINITIONS.map((d) => d.key);
    expect(keys).toEqual(expect.arrayContaining(["daily_goal.checkpoint_minutes", "daily_goal.day_boundary", "daily_goal.reminder_time"]));
    expect(keys).not.toContain("daily_goal.launch_time");
    expect(keys).not.toContain("daily_goal.candidate_projects");
  });

  it("launches a posted goal once, binds the session and sends checkpoints only when not waiting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = setup();
    const goal = await register(env);
    const confirmed = { goal };
    const missing = await env.runtime.surface.intake.post({ text: "プロジェクト: Cc\nゴール: x", messageId: "m2", actor });
    expect(missing).toMatchObject({ kind: "thread" });
    expect(env.runtime.service.list()).toHaveLength(1);

    await env.runtime.service.tick(sinceConfirm(confirmed.goal.confirmedAt, 0));
    await env.runtime.service.tick(sinceConfirm(confirmed.goal.confirmedAt, 1));
    expect(env.invocations).toHaveLength(1);
    expect(env.invocations[0]).toMatchObject({
      call_name: "daily-goal-runner", triggered_by: "daily-goal-run", spawn: true, options: { goal_and_go: true },
      task_binding: "caller", cwd: "E:/Document/Ars/Concordia", project: "Concordia", requester_discord_user_id: "neco",
    });

    env.sessions.insertSession({ id: "s1", provider: "claude-code", repo_path: "E:/Document/Ars/Concordia/.wt-x", repo_origin: null, branch: null,
      host: "h", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: JSON.stringify({ goal_and_go: { enabled: true, continuation_count: 5 } }) });
    env.runs.get(env.invocations[0]!.reserved_run_id!)!.child_session_id = "s1";
    await env.runtime.service.tick(sinceConfirm(confirmed.goal.confirmedAt, 2));
    const metadata = env.sessions.findSession("s1")!.metadata;
    expect(readWorkMode(metadata)).toMatchObject({ mode: "daily-goal-run", ref: confirmed.goal.id });

    // 回答待ちの間は inject も予算のリセットもしない。
    env.pendingQuestions.insert({ session_id: "s1", question: "どちら?", options: ["A", "B"] });
    await env.runtime.service.tick(sinceConfirm(confirmed.goal.confirmedAt, 63));
    expect(env.injects).toHaveLength(0);
    expect(readGoalAndGoStatus(env.sessions.findSession("s1")!.metadata).continuation_count).toBe(5);

    // 回答後は次の確認から通常どおり (進捗なし → 完了確認、止めない)。
    const question = env.pendingQuestions.findLatestUnanswered("s1")!;
    env.pendingQuestions.markAnsweredOther(question.id, "A");
    await env.runtime.service.tick(sinceConfirm(confirmed.goal.confirmedAt, 124));
    expect(env.injects).toHaveLength(1);
    expect(env.injects[0]).toMatchObject({ target_session_id: "s1", source: "auto:daily-goal-run" });
    expect(env.injects[0]!.text).toContain("完了確認");
    expect(env.runtime.service.detail(confirmed.goal.id)?.goal.status).toBe("running");

    // 停止は本人の操作だけ。停止後は自走を止め、方式を閉じる。
    env.runtime.surface.stop(confirmed.goal.id, actor);
    const after = env.sessions.findSession("s1")!.metadata;
    expect(readGoalAndGoStatus(after).enabled).toBe(false);
    expect(readWorkMode(after)).toBeNull();
    await env.runtime.service.tick(sinceConfirm(confirmed.goal.confirmedAt, 185));
    expect(env.invocations).toHaveLength(1);
  });

  it("marks the goal lost when the session is lost and does not relaunch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = setup();
    const handle = env.runtime.startScheduler();
    unsubscribers.push(() => handle.stop());
    const confirmed = { goal: await register(env) };
    await env.runtime.service.tick(sinceConfirm(confirmed.goal.confirmedAt, 0));
    env.runs.get(env.invocations[0]!.reserved_run_id!)!.child_session_id = "s1";
    env.sessions.insertSession({ id: "s1", provider: "claude-code", repo_path: "E:/x", repo_origin: null, branch: null, host: "h", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null });
    await env.runtime.service.tick(sinceConfirm(confirmed.goal.confirmedAt, 1));
    eventBus.emit({ type: "session.lost", session_id: "s1", ts: 1 });
    expect(env.runtime.service.detail(confirmed.goal.id)?.goal.status).toBe("lost");
    await env.runtime.service.tick(sinceConfirm(confirmed.goal.confirmedAt, 90));
    expect(env.invocations).toHaveLength(1);
  });

  it("stops at the 4:00 deadline and keeps the summary unwritten while Memoria is not ready", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = setup();
    const goal = await register(env);
    await env.runtime.service.tick(new Date(2026, 9, 11, 4, 0).getTime());
    expect(env.runtime.service.detail(goal.id)?.goal.status).toBe("deadline");
    expect(env.runtime.service.dayDetail("2026-10-10").day).toMatchObject({ closeState: "journaled", diaryState: "unwritten", noteState: "unwritten" });
  });
});
