import { describe, expect, it, vi } from "vitest";
import type { SessionReportRow, SessionRow } from "../shared/types.js";
import { endSessionNow, type EndSessionCommandDeps } from "./end-session-command.js";

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
});
