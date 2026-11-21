import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { UsageBudgetsRepo } from "../db/usage-budgets-repo.js";
import type { SessionEventRow, SessionRow } from "../shared/types.js";
import { BUDGET_EXHAUSTED_REASON, BUDGET_SUSPENSION_KEY, readSuspension } from "./budget-suspension.js";
import { UsageBudgetGate } from "./usage-budget-gate.js";
import { UsageBudgetTracker } from "./usage-budget-tracker.js";

const NOW = new Date(2026, 9, 15, 12).getTime();
const LAUNCHER = "111111111";
const HELPER = "222222222";

function setup(events: SessionEventRow[] = []) {
  const session: SessionRow = {
    id: "s1",
    provider: "claude-code",
    repo_path: "E:/repo",
    team_id: null,
    started_at: Math.floor(NOW / 1000) - 60,
    metadata: JSON.stringify({ discord_requester_user_id: LAUNCHER }),
  } as unknown as SessionRow;
  const budgets = new UsageBudgetsRepo(makeTestDb());
  const readUsage = vi.fn(async () => ({ total: 1_000 }));
  const sessionEvents = vi.fn((_sessionId: string) => events);
  const tracker = new UsageBudgetTracker({
    budgets,
    sessionsInRange: () => [session],
    readUsage,
    sessionEvents,
    now: () => NOW,
  });
  const endSession = vi.fn(async () => {});
  const gate = new UsageBudgetGate({
    tracker,
    findSession: (id) => (id === session.id ? session : null),
    mergeMetadata: (_id, partial) => {
      session.metadata = JSON.stringify({ ...JSON.parse(session.metadata ?? "{}"), ...partial });
    },
    readConversation: async () => ({ conversationId: "9914dcf2-7e21-4fcd-96ae-7dfe7c64d662", cwd: "E:/Document/Ars" }),
    endSession,
    log: { warn: vi.fn() },
    now: () => NOW,
  });
  return { session, budgets, tracker, gate, endSession, readUsage, sessionEvents };
}

describe("UsageBudgetGate", () => {
  it("予算が無い帰属先はツールを止めない", async () => {
    const { gate, endSession } = setup();
    expect(await gate.check("s1")).toEqual({ deny: false });
    expect(endSession).not.toHaveBeenCalled();
  });

  it("尽きたらツールを止め、 中断を 1 回だけ記録して通常の終了手順で終える", async () => {
    const { gate, budgets, session, endSession } = setup();
    budgets.upsert({ scope: "user", target_id: LAUNCHER, limit_tokens: 1_000, updated_by: null });
    expect(await gate.check("s1")).toMatchObject({ deny: true, reason: BUDGET_EXHAUSTED_REASON });
    await vi.waitFor(() => expect(endSession).toHaveBeenCalledTimes(1));
    expect(readSuspension(session.metadata)).toMatchObject({
      scope: "user", target_id: LAUNCHER, conversation_id: "9914dcf2-7e21-4fcd-96ae-7dfe7c64d662",
      cwd: "E:/Document/Ars", participants: [LAUNCHER], resumed_at: null,
    });
    // 記録したあとも止め続ける (終了までに作業を進めない)。 終了は二度目を呼ばない。
    expect(await gate.check("s1")).toMatchObject({ deny: true });
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(JSON.parse(session.metadata!)[BUDGET_SUSPENSION_KEY]).toBeTruthy();
  });

  it("助けに入った人の指示の区間は、 その人の予算で判定する", async () => {
    const { gate, budgets } = setup([
      { id: 1, session_id: "s1", ts: Math.floor(NOW / 1000) - 10, kind: "inject", payload: JSON.stringify({ source: `discord:${HELPER}:1:2` }) },
    ]);
    budgets.upsert({ scope: "user", target_id: LAUNCHER, limit_tokens: 1, updated_by: null });
    expect(await gate.check("s1")).toEqual({ deny: false });
    budgets.upsert({ scope: "user", target_id: HELPER, limit_tokens: 0, updated_by: null });
    expect(await gate.check("s1")).toMatchObject({ deny: true, subject: { scope: "user", targetId: HELPER } });
  });

  it("集計はキャッシュし、 ツール実行ごとにログを読まない", async () => {
    const { gate, budgets, readUsage } = setup();
    budgets.upsert({ scope: "user", target_id: LAUNCHER, limit_tokens: 100_000, updated_by: null });
    await gate.check("s1");
    await gate.check("s1");
    await gate.check("s1");
    expect(readUsage).toHaveBeenCalledTimes(1);
  });

  it("予算が 1 件も無ければ、 帰属の読み出し (inject イベント) も集計もせずに通す", async () => {
    const { gate, sessionEvents, readUsage, endSession } = setup([
      { id: 1, session_id: "s1", ts: Math.floor(NOW / 1000) - 10, kind: "inject", payload: JSON.stringify({ source: `discord:${HELPER}:1:2` }) },
    ]);
    expect(await gate.check("s1")).toEqual({ deny: false });
    expect(await gate.check("s1")).toEqual({ deny: false });
    expect(sessionEvents).not.toHaveBeenCalled();
    expect(readUsage).not.toHaveBeenCalled();
    expect(endSession).not.toHaveBeenCalled();
  });

  it("予算 0 件の早期の抜けは、 抜けずに判定したときと同じ結果になる", async () => {
    const events: SessionEventRow[] = [
      { id: 1, session_id: "s1", ts: Math.floor(NOW / 1000) - 10, kind: "inject", payload: JSON.stringify({ source: `discord:${HELPER}:1:2` }) },
    ];
    const shortcut = setup(events);
    const full = setup(events);
    // 抜けない経路: 予算があると答えさせて、 帰属の読み出しと cachedStatus まで通す。
    vi.spyOn(full.tracker, "hasAnyBudget").mockReturnValue(true);
    const expected = await full.gate.check("s1");
    expect(full.sessionEvents).toHaveBeenCalled();
    expect(await shortcut.gate.check("s1")).toEqual(expected);
    expect(shortcut.sessionEvents).not.toHaveBeenCalled();
  });

  it("予算を外しても、 中断済みのセッションは止め続ける", async () => {
    const { gate, budgets, tracker, endSession, sessionEvents } = setup();
    budgets.upsert({ scope: "user", target_id: LAUNCHER, limit_tokens: 1_000, updated_by: null });
    expect(await gate.check("s1")).toMatchObject({ deny: true });
    await vi.waitFor(() => expect(endSession).toHaveBeenCalledTimes(1));
    budgets.remove("user", LAUNCHER);
    tracker.invalidate();
    sessionEvents.mockClear();
    expect(await gate.check("s1")).toMatchObject({ deny: true, reason: BUDGET_EXHAUSTED_REASON, subject: { scope: "user", targetId: LAUNCHER } });
    expect(sessionEvents).not.toHaveBeenCalled();
  });

  it("予算を作って invalidate したら、 次の判定からすぐ効く", async () => {
    const { gate, budgets, tracker } = setup();
    expect(await gate.check("s1")).toEqual({ deny: false });
    budgets.upsert({ scope: "user", target_id: LAUNCHER, limit_tokens: 1_000, updated_by: null });
    // 予算を書く管理 API は invalidate を呼ぶ。
    tracker.invalidate();
    expect(await gate.check("s1")).toMatchObject({ deny: true, subject: { scope: "user", targetId: LAUNCHER } });
  });
});
