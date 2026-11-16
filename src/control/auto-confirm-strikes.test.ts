import { describe, it, expect } from "vitest";
import { eventBus } from "../events.js";
import type { SessionRow } from "../shared/types.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionFollowupSnapshot } from "./session-followup-state.js";
import {
  AUTO_CONFIRM_STRIKE_LIMIT,
  isAiWorkInProgress,
  readAutoConfirmStrikes,
  recordAutoConfirmStrike,
  renderStrikeOutNotice,
  startAutoConfirmStrikeReset,
} from "./auto-confirm-strikes.js";
import { startStalledSessionNudge } from "./stalled-session-nudge.js";
import { startNudgeProgress } from "./nudge-delivery.js";

function fakeSession(id: string): SessionRow {
  return {
    id, provider: "claude-code", repo_path: "/r", repo_origin: null, branch: null, host: "h",
    started_at: 0, ended_at: null, status: "active", last_seen_at: 0, current_task: null,
    transcript_path: null, metadata: null, ws_clients: 0,
  } as SessionRow;
}

function fakeRepo(active: SessionRow[]): SessionsRepo {
  const update = (id: string, fn: (current: Record<string, unknown>) => Record<string, unknown>) => {
    const row = active.find((item) => item.id === id);
    if (row) row.metadata = JSON.stringify(fn(JSON.parse(row.metadata ?? "{}")));
  };
  return {
    findAllActive: () => active,
    findSession: (id: string) => active.find((row) => row.id === id) ?? null,
    updateMetadata: update,
    mergeMetadata: (id: string, patch: Record<string, unknown>) => update(id, (current) => ({ ...current, ...patch })),
  } as unknown as SessionsRepo;
}

describe("auto-confirm strikes (3 アウト)", () => {
  it("回数を数え、壊れた値は 0 とみなす", () => {
    const row = fakeSession("s");
    const repo = fakeRepo([row]);
    expect(readAutoConfirmStrikes("not json")).toBe(0);
    expect(readAutoConfirmStrikes(JSON.stringify({ cc_auto_confirm_strikes: -2 }))).toBe(0);
    expect(recordAutoConfirmStrike(repo, "s")).toBe(1);
    expect(recordAutoConfirmStrike(repo, "s")).toBe(2);
    expect(readAutoConfirmStrikes(row.metadata)).toBe(2);
  });

  it("3 回目の本文にだけ停止予告を添える", () => {
    expect(renderStrikeOutNotice(AUTO_CONFIRM_STRIKE_LIMIT - 1)).toEqual([]);
    expect(renderStrikeOutNotice(AUTO_CONFIRM_STRIKE_LIMIT).join("\n")).toContain("自動確認を送りません");
  });

  it("来歴付きの人間入力で 0 に戻し、自動注入では戻さない", () => {
    const row = fakeSession("s");
    row.metadata = JSON.stringify({ cc_auto_confirm_strikes: 3 });
    const watch = startAutoConfirmStrikeReset(fakeRepo([row]));
    try {
      eventBus.emit({ type: "session.inject", target_session_id: "s", text: "x", source: "auto:stall-nudge", ts: 1 });
      expect(readAutoConfirmStrikes(row.metadata)).toBe(3);
      eventBus.emit({ type: "question.answered", target_session_id: "s", question_id: 1, answer_index: 0, answer_text: "OK", ts: 2 });
      expect(readAutoConfirmStrikes(row.metadata)).toBe(0);
    } finally {
      watch.stop();
    }
  });

  it("セッションが返答し続けても、人間の反応が無ければ 3 回で止まる", async () => {
    let clock = 10_000_000;
    let mtime = 0;
    const injected: string[] = [];
    const off = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.target_session_id === "loop") injected.push(event.text);
    });
    const h = startStalledSessionNudge({
      repo: fakeRepo([fakeSession("loop")]),
      now: () => clock,
      transcriptMtimeMs: async () => mtime,
      readTranscriptTail: async () => JSON.stringify({ role: "assistant", content: "通知を待っています。" }),
      idleSec: 600,
      cooldownSec: 600,
      intervalMs: 1_000_000,
    });
    try {
      for (let i = 0; i < 5; i += 1) {
        await h.runOnce();
        mtime = clock + 60_000; // セッションは毎回返答する
        clock += 3_600_000;
      }
      expect(injected).toHaveLength(AUTO_CONFIRM_STRIKE_LIMIT);
      expect(injected[AUTO_CONFIRM_STRIKE_LIMIT - 1]).toContain("自動確認を送りません");
    } finally {
      h.stop();
      off();
    }
  });

  it.each(["claude-code", "codex-cli"] as const)("Lictor の最終 frame 時刻で判定しても 3 回で止まる (%s)", async (provider) => {
    let clock = 10_000_000;
    let activity = 0;
    const id = `lictor-loop-${provider}`;
    const injected: string[] = [];
    const off = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.target_session_id === id) injected.push(event.text);
    });
    const h = startStalledSessionNudge({
      repo: fakeRepo([{ ...fakeSession(id), provider }]),
      now: () => clock,
      lastActivityMs: () => activity,
      transcriptMtimeMs: async () => 0, // mtime は判定に使われない
      readTranscriptTail: async () => JSON.stringify({ role: "assistant", content: "通知を待っています。" }),
      idleSec: 600,
      cooldownSec: 600,
      intervalMs: 1_000_000,
    });
    try {
      for (let i = 0; i < 5; i += 1) {
        await h.runOnce();
        activity = clock + 60_000; // セッションは毎回返答し、Lictor が frame を送る
        clock += 3_600_000;
      }
      expect(injected).toHaveLength(AUTO_CONFIRM_STRIKE_LIMIT);
      expect(injected[AUTO_CONFIRM_STRIKE_LIMIT - 1]).toContain("自動確認を送りません");
    } finally {
      h.stop();
      off();
    }
  });
});

describe("AI が進められる作業の継続誘導 (2026-10-08 neco 指示)", () => {
  it("AI が進められる状態だけを対象にし、通知待ちと不明は含めない", () => {
    for (const state of ["task-active", "review-needed", "review-failed", "merge-confirmation", "reflection-needed"] as const) {
      expect(isAiWorkInProgress(state)).toBe(true);
    }
    for (const state of ["review-wait", "delegation-wait", "unknown", "task-blocked"] as const) {
      expect(isAiWorkInProgress(state)).toBe(false);
    }
    expect(isAiWorkInProgress(null)).toBe(false);
  });

  async function runLoop(
    snapshot: SessionFollowupSnapshot | SessionFollowupSnapshot[] | null, rounds: number,
    extra: { hasPendingQuestion?: (sessionId: string) => boolean; metadata?: Record<string, unknown> } = {},
  ) {
    let clock = 10_000_000;
    let mtime = 0;
    const row = fakeSession("work");
    if (extra.metadata) row.metadata = JSON.stringify(extra.metadata);
    const injected: string[] = [];
    const reported: string[] = [];
    let resolved = 0;
    let stallNudged = 0;
    const off = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.target_session_id === "work") injected.push(event.text);
      if (event.type === "session.stall_nudged" && event.target_session_id === "work") stallNudged += 1;
    });
    const h = startStalledSessionNudge({
      repo: fakeRepo([row]),
      now: () => clock,
      transcriptMtimeMs: async () => mtime,
      readTranscriptTail: async () => JSON.stringify({ role: "assistant", content: "続けます。" }),
      resolveWorkState: async () => {
        if (snapshot === null) throw new Error("state lookup failed");
        return Array.isArray(snapshot) ? snapshot[resolved++ % snapshot.length]! : snapshot;
      },
      reportHumanTodos: (session) => { reported.push(session.id); },
      ...(extra.hasPendingQuestion ? { hasPendingQuestion: extra.hasPendingQuestion } : {}),
      idleSec: 600,
      cooldownSec: 600,
      intervalMs: 1_000_000,
    });
    try {
      for (let i = 0; i < rounds; i += 1) {
        await h.runOnce();
        mtime = clock + 60_000; // セッションは毎回返答する
        clock += 3_600_000;
      }
    } finally {
      h.stop();
      off();
    }
    return { injected, reported, stallNudged, strikes: readAutoConfirmStrikes(row.metadata) };
  }

  it("Cc が残作業を確認できる状態 (task-active) では 4 回目以降も確認を続ける (2026-11-16)", async () => {
    const result = await runLoop({ workflow: "github", tasks: [{ status: "in_progress" }], delegations: [], prs: [] }, 5);
    expect(result.injected).toHaveLength(5);
    expect(result.injected.at(-1)).toContain("状況と残作業を確認し");
    expect(result.injected.join("\n")).not.toContain("自動確認を送りません");
    expect(result.strikes).toBe(5);
  });

  it("審査の通知待ち (review-wait) も止めず、変化の無い回は Discord へ通知しない", async () => {
    const result = await runLoop({ workflow: "github", tasks: [], delegations: [], prs: [{ status: "open", checkStatus: "running" }] }, 5);
    expect(result.injected).toHaveLength(5);
    expect(result.stallNudged).toBe(1);
    expect(result.injected[0]).not.toContain("[変化なし]");
    expect(result.injected[1]).toContain("作業状態は変わっていません");
    expect(result.injected[1]).toContain("[変化なし]");
  });

  it("作業状態が毎回変われば毎回 Discord へ通知する", async () => {
    const result = await runLoop([
      { workflow: "revisor", tasks: [{ status: "in_progress" }], delegations: [], prs: [] },
      { workflow: "revisor", tasks: [], delegations: [], prs: [{ status: "open", checkStatus: "test_ok" }] },
    ], 6);
    expect(result.injected).toHaveLength(6);
    expect(result.stallNudged).toBe(6);
    expect(result.injected.join("\n")).not.toContain("作業状態は変わっていません");
  });

  it("3 アウト後も人間のやることの照合は毎周続ける", async () => {
    const result = await runLoop({ workflow: "github", tasks: [], delegations: [], prs: [{ status: "open", checkStatus: "running" }] }, 5);
    expect(result.reported).toHaveLength(5);
  });

  async function runOnceWithStrikes(snapshot: SessionFollowupSnapshot) {
    const row = fakeSession("struck");
    row.metadata = JSON.stringify({ cc_auto_confirm_strikes: AUTO_CONFIRM_STRIKE_LIMIT });
    const injected: string[] = [];
    const off = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.target_session_id === "struck") injected.push(event.text);
    });
    const h = startStalledSessionNudge({
      repo: fakeRepo([row]),
      now: () => 10_000_000,
      transcriptMtimeMs: async () => 0,
      readTranscriptTail: async () => JSON.stringify({ role: "assistant", content: "続けます。" }),
      resolveWorkState: async () => snapshot,
      idleSec: 600,
      intervalMs: 1_000_000,
    });
    try {
      return { nudged: await h.runOnce(), injected, strikes: readAutoConfirmStrikes(row.metadata) };
    } finally {
      h.stop();
      off();
    }
  }

  it("永続化された 3 アウトでも審査失敗 (review-failed) なら確認を送り、修正・再提出を促す", async () => {
    const result = await runOnceWithStrikes(
      { workflow: "revisor", tasks: [], delegations: [], prs: [{ status: "open", checkStatus: "failed" }] });
    expect(result.nudged).toEqual(["struck"]);
    expect(result.injected[0]).toContain("state=review-failed");
    expect(result.injected[0]).toContain("同じ PR へ再提出");
    expect(result.injected[0]).not.toContain("自動確認を送りません");
    expect(result.strikes).toBe(AUTO_CONFIRM_STRIKE_LIMIT + 1);
  });

  it("永続化された 3 アウトでも state=unknown なら確認を送り、停止予告を添えない (2026-11-16 不明でも確認)", async () => {
    const result = await runOnceWithStrikes({ workflow: "revisor", tasks: [{ status: "unknown" }], delegations: [], prs: [] });
    expect(result.nudged).toEqual(["struck"]);
    expect(result.injected[0]).toContain("state=unknown");
    expect(result.injected[0]).not.toContain("自動確認を送りません");
    expect(result.strikes).toBe(AUTO_CONFIRM_STRIKE_LIMIT + 1);
  });

  it("同じ中身の unknown も毎回確認し、変化の無い回は Discord へ通知せず [変化なし] を案内する", async () => {
    const unlinked: SessionFollowupSnapshot = {
      workflow: "revisor", tasks: [], delegations: [], prs: [], unavailable: [],
      linkFailures: [{ task_reference: "actio:162bc3a6", reason: "task_out_of_scope" }],
    };
    const result = await runLoop(unlinked, 5);
    expect(result.injected).toHaveLength(5);
    expect(result.injected.every((text) => text.includes("state=unknown"))).toBe(true);
    expect(result.injected[0]).toContain("actio:162bc3a6 (task_out_of_scope)");
    expect(result.injected[0]).not.toContain("[変化なし]");
    expect(result.injected.slice(1).every((text) => text.includes("[変化なし]"))).toBe(true);
    expect(result.injected.join("\n")).not.toContain("自動確認を送りません");
    expect(result.stallNudged).toBe(1);
    expect(result.strikes).toBe(5);
  });

  it("unknown の中身が変われば Discord へ通知する", async () => {
    const result = await runLoop([
      { workflow: "revisor", tasks: [], delegations: [], prs: [], linkFailures: [{ task_reference: "actio:a", reason: "not_found" }] },
      { workflow: "revisor", tasks: [], delegations: [], prs: [], linkFailures: [{ task_reference: "actio:b", reason: "not_found" }] },
    ], 4);
    expect(result.injected).toHaveLength(4);
    expect(result.stallNudged).toBe(4);
  });

  it("状態照会が失敗した回 (unknown 扱い) も 3 アウトで止めない", async () => {
    const result = await runLoop(null, 5);
    expect(result.injected).toHaveLength(5);
    expect(result.injected[0]).toContain("state=unknown");
    expect(result.injected.join("\n")).not.toContain("自動確認を送りません");
  });

  it("unknown でも質問カード待ち・human-wait は従来どおり止める", async () => {
    const unknown: SessionFollowupSnapshot = { workflow: "revisor", tasks: [{ status: "unknown" }], delegations: [], prs: [] };
    expect((await runLoop(unknown, 3, { hasPendingQuestion: () => true })).injected).toEqual([]);
    const waiting = await runLoop(unknown, 3, {
      metadata: { cc_human_wait: { active: true, summary: "判断待ち", task_references: [], since: 1 } },
    });
    expect(waiting.injected).toEqual([]);
  });

  it("永続化された 3 アウトは状態照会の無い構成では外部照会せず止め、新しい審査通知で再開する", async () => {
    let clock = 10_000_000;
    const row = fakeSession("resume");
    row.metadata = JSON.stringify({ cc_auto_confirm_strikes: AUTO_CONFIRM_STRIKE_LIMIT });
    const injected: string[] = [];
    const off = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.target_session_id === "resume") injected.push(event.text);
    });
    const repo = fakeRepo([row]);
    const progress = startNudgeProgress(repo);
    const h = startStalledSessionNudge({
      repo,
      now: () => clock,
      transcriptMtimeMs: async () => 0,
      readTranscriptTail: async () => JSON.stringify({ role: "assistant", content: "続けます。" }),
      idleSec: 600,
      intervalMs: 1_000_000,
    });
    try {
      expect(await h.runOnce()).toEqual([]);
      eventBus.emit({ type: "session.inject", target_session_id: "resume", source: "revisor", text: "review complete", ts: 1 });
      injected.length = 0;
      expect(await h.runOnce()).toEqual(["resume"]);
      expect(readAutoConfirmStrikes(row.metadata)).toBe(1);
    } finally {
      progress.stop();
      h.stop();
      off();
    }
  });
});
