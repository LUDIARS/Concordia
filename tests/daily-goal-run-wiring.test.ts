/**
 * デイリーゴールの配線テスト (spec/feature/daily-goal-run.md — 受け入れ基準)。
 *
 * composition root (bootstrap/daily-goal-run.ts) を実 DB の repo で組み、 投稿 → 登録 (セッションは起動しない) →
 * 1 時間ごとのワンショット判定 → 不調の通知 → 停止 → 締切 までを通す。 外部 (git・Actio・LLM・Memoria) は fake。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { PrRecordsRepo } from "../src/db/pr-records-repo.js";
import { ProjectCodesRepo } from "../src/db/project-codes-repo.js";
import { StaffRepo } from "../src/db/staff-repo.js";
import { eventBus, type ConcordiaEvent } from "../src/events.js";
import { createDailyGoalRuntime } from "../src/bootstrap/daily-goal-run.js";
import { commandNamesForRegistration } from "../src/discord/commands.js";
import { workflowForCommand } from "../src/discord/command-workflow.js";
import { WORKFLOW_KEYS, workflowDefaultEnabled } from "../src/workflow/keys.js";
import { SETTING_DEFINITIONS } from "../src/config/settings/definitions/index.js";
import type { JudgeResult } from "../src/daily-goal-run/progress-judge.js";

/** 投稿の時刻 (業務日 2026-10-10 の 10:00)。 締切は 10/11 04:00。 */
const POSTED_AT = new Date(2026, 9, 10, 10, 0).getTime();
const after = (minutes: number) => POSTED_AT + minutes * 60_000;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const unsubscribers: Array<() => void> = [];
afterEach(() => { for (const off of unsubscribers.splice(0)) off(); vi.useRealTimers(); });

function setup() {
  const db = makeTestDb();
  const sessions = new SessionsRepo(db);
  const projectCodes = new ProjectCodesRepo(db);
  projectCodes.register({ code: "Cc", project: "Concordia", repoPath: "E:/Document/Ars/Concordia", repoOrigin: "LUDIARS/Concordia", addedBy: "test" });
  const settings = new Map<string, string>();
  const judge = { result: { ok: true, raw: { verdict: "on_track", reason: "順調", acceptance: [] } } as JudgeResult, calls: 0 };
  const runtime = createDailyGoalRuntime({
    db, sessions, prs: new PrRecordsRepo(db), projectCodes, staff: new StaffRepo(db),
    taskStore: () => ({ findByRelativePath: async () => ({ status: "pending" }), findForProject: async () => [] }) as never,
    settings: { get: (key: string) => settings.get(key) ?? null },
    isEnabled: () => true,
    extraction: { extract: async () => ({ ok: false as const, error: "llm unavailable" }) },
    judge: { judge: async () => { judge.calls++; return structuredClone(judge.result); } },
    journal: {
      putDiarySection: async () => ({ ok: false as const, kind: "rejected" as const, error: "memoria responded 404" }),
      getDiarySection: async () => ({ ok: true as const, value: { exists: false } }),
      createNote: async () => ({ ok: false as const, kind: "rejected" as const, error: "memoria responded 404" }),
    },
    log: { info: () => undefined, warn: () => undefined },
  });
  const events: ConcordiaEvent[] = [];
  unsubscribers.push(eventBus.subscribe((event) => { if (event.type === "session.inject") events.push(event); }));
  return { db, sessions, runtime, judge, events };
}

const actor = { userId: "neco", guildId: "g", channelId: "c", isBot: false, isWebhook: false };
const POST = ["プロジェクト: Cc", "ゴール: デイリーゴールを出荷する", "受入条件: PR がマージされる", "task: t1"].join("\n");

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

  it("registers without a session, judges hourly and queues one poster-only alert when poor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = setup();
    const goal = await register(env);
    expect(goal.status).toBe("running");
    expect(env.sessions.findAllActive()).toEqual([]);

    await env.runtime.service.tick(after(30));
    expect(env.judge.calls).toBe(0);
    await env.runtime.service.tick(after(60));
    expect(env.judge.calls).toBe(1);

    env.judge.result = { ok: true, raw: { verdict: "stalled", reason: "<@999> 動きなし", acceptance: [{ index: 1, outlook: "unlikely", refs: [] }] } };
    await env.runtime.service.tick(after(120));
    await env.runtime.service.tick(after(180));
    const pending = env.runtime.surface.alerts.pending(after(180));
    expect(pending).toHaveLength(1);
    expect(env.runtime.surface.alerts.content(pending[0]!)).toMatchObject({ mentionUserId: "neco", threadId: null });
    expect(env.runtime.surface.alerts.claim(pending[0]!.id)).toBe(true);
    env.runtime.surface.alerts.unknownResult(pending[0]!.id, "timeout");
    expect(env.runtime.surface.alerts.pending(after(240))).toEqual([]);
    expect(env.events).toEqual([]);

    env.runtime.surface.stop(goal.id, actor);
    await env.runtime.service.tick(after(300));
    expect(env.judge.calls).toBe(3);
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
