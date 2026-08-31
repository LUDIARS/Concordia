import { describe, expect, it, vi } from "vitest";
import type { SessionReportRow, SessionRow } from "../shared/types.js";
import { SESSION_END_PENDING_AT_KEY } from "./session-end-process.js";

vi.mock("./end-session-flow.js", () => ({
  runSessionEndFlow: vi.fn(async () => ({ report: null })),
}));

const { endSessionNow } = await import("./end-session-command.js");
type EndSessionCommandDeps = Parameters<typeof endSessionNow>[0];

describe("endSessionNow", () => {
  it("returns the existing result without repeating end side effects", async () => {
    const requestedSession = { id: "ended", status: "active" } as SessionRow;
    const endedSession = { id: requestedSession.id, status: "ended" } as SessionRow;
    const report = { session_id: requestedSession.id } as SessionReportRow;
    const repo = {
      findSession: vi.fn(() => endedSession),
      findReport: vi.fn(() => report),
      mergeMetadata: vi.fn(),
      setStatus: vi.fn(),
      appendEvent: vi.fn(),
    };

    await expect(endSessionNow(
      { repo } as unknown as EndSessionCommandDeps,
      requestedSession,
      "duplicate request",
    )).resolves.toEqual({ session: endedSession, report });

    expect(repo.mergeMetadata).not.toHaveBeenCalled();
    expect(repo.setStatus).not.toHaveBeenCalled();
    expect(repo.appendEvent).not.toHaveBeenCalled();
  });

  it("marks session_end_pending_at for a lost session before transitioning to ended", async () => {
    const requestedSession = { id: "s-lost", status: "lost", metadata: null } as unknown as SessionRow;
    const repo = {
      findSession: vi.fn(() => requestedSession),
      findReport: vi.fn(() => null),
      mergeMetadata: vi.fn(),
      setStatus: vi.fn(),
      appendEvent: vi.fn(),
      allEvents: vi.fn(() => []),
    };

    await endSessionNow(
      { repo } as unknown as EndSessionCommandDeps,
      requestedSession,
      "test: lost session DELETE",
      () => 1000,
    );

    // lost セッションでもマーカーを立ててから ended 化する: これが無いと
    // lost-session-process-reaper (status==="lost" 限定) と
    // expired-session-end-reaper (マーカー必須) のどちらの回収対象からも漏れる。
    expect(repo.mergeMetadata).toHaveBeenCalledWith("s-lost", { [SESSION_END_PENDING_AT_KEY]: 1000 });
    expect(repo.setStatus).toHaveBeenCalledWith("s-lost", "ended", 1000, 1000);
  });

  it("does not overwrite an existing session_end_pending_at marker", async () => {
    const existingMetadata = JSON.stringify({ [SESSION_END_PENDING_AT_KEY]: 500 });
    const requestedSession = {
      id: "s-lost-2",
      status: "lost",
      metadata: existingMetadata,
    } as unknown as SessionRow;
    const repo = {
      findSession: vi.fn(() => requestedSession),
      findReport: vi.fn(() => null),
      mergeMetadata: vi.fn(),
      setStatus: vi.fn(),
      appendEvent: vi.fn(),
      allEvents: vi.fn(() => []),
    };

    await endSessionNow(
      { repo } as unknown as EndSessionCommandDeps,
      requestedSession,
      "test: lost session DELETE, already pending",
      () => 1000,
    );

    expect(repo.mergeMetadata).not.toHaveBeenCalled();
  });
});
