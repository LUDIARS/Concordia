import { describe, expect, it, vi } from "vitest";
import {
  detectsEndSessionRequest,
  END_SESSION_REQUESTED_AT_KEY,
  selectDueEndSessionRequests,
  startEndSessionRequestWatch,
} from "./end-session-request.js";
import type { SessionRow } from "../shared/types.js";
import type { SessionsRepo } from "../db/sessions-repo.js";

function session(overrides: Partial<SessionRow> & { id: string }): SessionRow {
  return {
    status: "active",
    last_seen_at: 1000,
    started_at: 0,
    metadata: null,
    ...overrides,
  } as SessionRow;
}

function requestedAt(ts: number): string {
  return JSON.stringify({ [END_SESSION_REQUESTED_AT_KEY]: ts });
}

describe("detectsEndSessionRequest", () => {
  it("終了指示を拾う (空白・言い回しの揺れを含む)", () => {
    expect(detectsEndSessionRequest("セッション終了")).toBe(true);
    expect(detectsEndSessionRequest("セッションを終了して")).toBe(true);
    expect(detectsEndSessionRequest("では セッション 終了 で")).toBe(true);
    expect(detectsEndSessionRequest("session-end してください")).toBe(true);
    expect(detectsEndSessionRequest("このセッションを終了してください")).toBe(true);
  });

  it("打ち消しを含む文は対象外 (誤終了させない)", () => {
    expect(detectsEndSessionRequest("セッション終了しないで")).toBe(false);
    expect(detectsEndSessionRequest("まだセッション終了は不要")).toBe(false);
  });

  it("無関係な発言は拾わない", () => {
    expect(detectsEndSessionRequest("この処理を終了条件にしよう")).toBe(false);
    expect(detectsEndSessionRequest("session-end skill の実装をレビューして")).toBe(false);
    expect(detectsEndSessionRequest("セッション終了について相談したい")).toBe(false);
    expect(detectsEndSessionRequest("")).toBe(false);
  });
});

describe("selectDueEndSessionRequests", () => {
  const rows = () => [
    session({ id: "quiet", metadata: requestedAt(1000), last_seen_at: 1000 }),
    session({ id: "busy", metadata: requestedAt(1000), last_seen_at: 1180 }),
    session({ id: "no-request", metadata: null, last_seen_at: 100 }),
    session({ id: "ended", status: "ended", metadata: requestedAt(1000), last_seen_at: 1000 }),
  ];

  it("要求後に静かになった active session だけを選ぶ", () => {
    const due = selectDueEndSessionRequests(rows(), { nowSec: 1200, idleSec: 90 });
    expect(due.map((row) => row.id)).toEqual(["quiet"]);
  });

  it("静かにならなくても上限を超えたら選ぶ", () => {
    const due = selectDueEndSessionRequests(rows(), { nowSec: 3000, idleSec: 90, maxWaitSec: 900 });
    expect(due.map((row) => row.id)).toEqual(["quiet", "busy"]);
  });

  it("要求直後 (まだ喋っている最中) は選ばない", () => {
    expect(selectDueEndSessionRequests(rows(), { nowSec: 1010, idleSec: 90 })).toEqual([]);
  });
});

describe("startEndSessionRequestWatch", () => {
  it("runs the shared end command for a due request", async () => {
    vi.useFakeTimers();
    try {
      const due = session({ id: "due", metadata: requestedAt(1000), last_seen_at: 1000 });
      const endSession = vi.fn(async () => undefined);
      const handle = startEndSessionRequestWatch({
        sessions: { listSessions: vi.fn(() => [due]) } as unknown as SessionsRepo,
        endSession,
        nowSec: () => 1200,
        intervalMs: 1000,
      });

      await vi.advanceTimersByTimeAsync(1000);

      expect(endSession).toHaveBeenCalledWith(due, "spoken session-end request");
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
