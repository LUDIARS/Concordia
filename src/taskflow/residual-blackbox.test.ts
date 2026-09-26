import { describe, expect, it, vi } from "vitest";
import { checkResidual } from "./residual-blackbox.js";
import { eventBus } from "../events.js";

describe("Actio residual continuation", () => {
  function fixture(blocked = false) {
    const nextExecutable = vi.fn(async () => blocked ? null : { path: "actio:critical" });
    const input = { sessionId: "session", sessions: { findSession: () => ({ repo_path: "repo", metadata: "{}" }) },
      store: { findForProject: async () => [{ path: "actio:first" }, { path: "actio:critical" }], nextExecutable,
        relativePath: (task: { path: string }) => task.path } } as unknown as Parameters<typeof checkResidual>[0];
    return { input, nextExecutable };
  }
  it("uses the authoritative executable selection instead of list order", async () => {
    const { input } = fixture();
    const texts: string[] = [];
    const stop = eventBus.subscribe((event) => { if (event.type === "taskflow.continue_requested") texts.push(event.text); });
    try { expect(await checkResidual(input)).toBe("next-task"); expect(texts).toEqual([expect.stringContaining("actio:critical")]); }
    finally { stop(); }
  });
  it("waits when every remaining task is blocked", async () => {
    const { input } = fixture(true);
    expect(await checkResidual(input)).toBe("waiting");
  });
  it("keeps unanswered human questions ahead of candidate selection", async () => {
    const { input, nextExecutable } = fixture();
    input.hasPendingQuestion = () => true;
    expect(await checkResidual(input)).toBe("waiting");
    expect(nextExecutable).not.toHaveBeenCalled();
  });
});
