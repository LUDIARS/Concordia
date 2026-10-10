/**
 * デイリーゴール自走の配線テスト (spec/feature/daily-goal-run.md — 受け入れ基準)。
 *
 * composition root (bootstrap/daily-goal-run.ts) を実 DB の repo で組み、 確定 → 起動 → 紐付け →
 * 確認の inject → 回答待ちの抑止 → 停止 までを通す。 外部プロセス (delegation の spawn・git・Actio) は fake。
 */

import { afterEach, describe, expect, it } from "vitest";
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

/**
 * 確定は実時計で行われるので、 tick は確定時刻の 24 時間後を起点に進める
 * (起動時刻 07:30 か確定時刻の遅い方を必ず過ぎている。日付をまたいでも止めない仕様なので影響しない)。
 */
const sinceConfirm = (confirmedAt: number, minutes: number) => confirmedAt + 24 * 3_600_000 + minutes * 60_000;
const unsubscribers: Array<() => void> = [];
afterEach(() => { for (const off of unsubscribers.splice(0)) off(); });

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
    log: { info: () => undefined, warn: () => undefined },
  });
  const injects: Array<Extract<ConcordiaEvent, { type: "session.inject" }>> = [];
  unsubscribers.push(eventBus.subscribe((event) => { if (event.type === "session.inject") injects.push(event); }));
  return { db, sessions, pendingQuestions, runtime, invocations, runs, injects };
}

const actor = { userId: "neco", guildId: "g", channelId: "c", isBot: false, isWebhook: false };
const draft = {
  project: "Cc", goalText: "デイリーゴール自走を出荷する", acceptance: ["PR がマージされる"], actioTaskIds: ["t1"],
  permissions: { merge: false, test: false, service: false, deploy: false },
};

describe("daily-goal-run wiring", () => {
  it("registers the command, workflow toggle and settings", () => {
    expect(commandNamesForRegistration()).toContain("co-daily-goal");
    expect(commandNamesForRegistration({ isWorkflowEnabled: (key) => key !== "daily_goal" })).not.toContain("co-daily-goal");
    expect(workflowForCommand("co-daily-goal")).toBe("daily_goal");
    expect(WORKFLOW_KEYS).toContain("daily_goal");
    expect(workflowDefaultEnabled("daily_goal")).toBe(true);
    const keys = SETTING_DEFINITIONS.map((d) => d.key);
    expect(keys).toEqual(expect.arrayContaining(["daily_goal.launch_time", "daily_goal.checkpoint_minutes", "daily_goal.candidate_projects"]));
  });

  it("launches a human-confirmed goal once, binds the session and sends checkpoints only when not waiting", async () => {
    const env = setup();
    const confirmed = env.runtime.surface.confirm({ draft, actor, receiptId: "interaction-1" });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(env.runtime.surface.confirm({ draft: { ...draft, acceptance: [] }, actor, receiptId: "interaction-2" })).toMatchObject({ ok: false, kind: "missing" });

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
    const env = setup();
    const handle = env.runtime.startScheduler();
    unsubscribers.push(() => handle.stop());
    const confirmed = env.runtime.surface.confirm({ draft, actor, receiptId: "interaction-1" });
    if (!confirmed.ok) throw new Error("confirm failed");
    await env.runtime.service.tick(sinceConfirm(confirmed.goal.confirmedAt, 0));
    env.runs.get(env.invocations[0]!.reserved_run_id!)!.child_session_id = "s1";
    env.sessions.insertSession({ id: "s1", provider: "claude-code", repo_path: "E:/x", repo_origin: null, branch: null, host: "h", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null });
    await env.runtime.service.tick(sinceConfirm(confirmed.goal.confirmedAt, 1));
    eventBus.emit({ type: "session.lost", session_id: "s1", ts: 1 });
    expect(env.runtime.service.detail(confirmed.goal.id)?.goal.status).toBe("lost");
    await env.runtime.service.tick(sinceConfirm(confirmed.goal.confirmedAt, 90));
    expect(env.invocations).toHaveLength(1);
  });
});
