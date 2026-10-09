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

  async function runLoop(snapshot: SessionFollowupSnapshot, rounds: number) {
    let clock = 10_000_000;
    let mtime = 0;
    const row = fakeSession("work");
    const injected: string[] = [];
    const reported: string[] = [];
    const off = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.target_session_id === "work") injected.push(event.text);
    });
    const h = startStalledSessionNudge({
      repo: fakeRepo([row]),
      now: () => clock,
      transcriptMtimeMs: async () => mtime,
      readTranscriptTail: async () => JSON.stringify({ role: "assistant", content: "続けます。" }),
      resolveWorkState: async () => snapshot,
      reportHumanTodos: (session) => { reported.push(session.id); },
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
    return { injected, reported, strikes: readAutoConfirmStrikes(row.metadata) };
  }

  it("実装中のタスクがあれば 3 アウトで止めず、状況と残作業の確認を促し続ける", async () => {
    const result = await runLoop({ workflow: "github", tasks: [{ status: "in_progress" }], delegations: [], prs: [] }, 5);
    expect(result.injected).toHaveLength(5);
    expect(result.injected.at(-1)).toContain("状況と残作業を確認し");
    expect(result.injected.join("\n")).not.toContain("自動確認を送りません");
    expect(result.strikes).toBe(0);
  });

  it("審査の通知待ちは従来どおり 3 回で止まる", async () => {
    const result = await runLoop({ workflow: "github", tasks: [], delegations: [], prs: [{ status: "open", checkStatus: "running" }] }, 5);
    expect(result.injected).toHaveLength(AUTO_CONFIRM_STRIKE_LIMIT);
    expect(result.strikes).toBe(AUTO_CONFIRM_STRIKE_LIMIT);
  });

  it("3 アウト後も人間のやることの照合は毎周続ける", async () => {
    const result = await runLoop({ workflow: "github", tasks: [], delegations: [], prs: [{ status: "open", checkStatus: "running" }] }, 5);
    expect(result.reported).toHaveLength(5);
  });

  it("3 アウト済みでも、AI の作業が再び進められる状態なら誘導を再開する", async () => {
    let clock = 10_000_000;
    const row = fakeSession("resume");
    row.metadata = JSON.stringify({ cc_auto_confirm_strikes: AUTO_CONFIRM_STRIKE_LIMIT });
    const injected: string[] = [];
    const off = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.target_session_id === "resume") injected.push(event.text);
    });
    const h = startStalledSessionNudge({
      repo: fakeRepo([row]),
      now: () => clock,
      transcriptMtimeMs: async () => 0,
      readTranscriptTail: async () => JSON.stringify({ role: "assistant", content: "続けます。" }),
      resolveWorkState: async () => ({ workflow: "github", tasks: [], delegations: [], prs: [{ status: "open", checkStatus: "failed" }] }),
      idleSec: 600,
      intervalMs: 1_000_000,
    });
    try {
      expect(await h.runOnce()).toEqual(["resume"]);
      expect(injected[0]).toContain("状況と残作業を確認し");
    } finally {
      h.stop();
      off();
    }
  });
});
