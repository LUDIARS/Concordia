/** @implements spec/feature/task-workflow-v3.md — CC-TF-SESSION-01 */
import { describe, expect, it } from "vitest";
import { assignTaskWorker, taskSessionMetadata } from "./session-metadata.js";

describe("task session metadata policy", () => {
  it("keeps historical and human provenance empty rather than guessing it", () => {
    expect(taskSessionMetadata(null)).toEqual({ issued_by_session_id: null, working_session_id: null });
    expect(assignTaskWorker({ source_session: "ambiguous", extra: 7 }, "worker")).toEqual({
      source_session: "ambiguous", extra: 7, issued_by_session_id: null, working_session_id: "worker",
    });
  });
  it("preserves the issuer and rejects a stale release after handover", () => {
    const original = { issued_by_session_id: "issuer", working_session_id: "old", memory_links: ["m1"] };
    const next = assignTaskWorker(original, "new", "old");
    expect(next).toEqual({ ...original, working_session_id: "new" });
    expect(original.working_session_id).toBe("old");
    expect(() => assignTaskWorker(next, null, "old")).toThrow("Task working session changed");
    expect(assignTaskWorker(next, "new", "old")).toEqual(next);
    expect(assignTaskWorker(next, null, "new").issued_by_session_id).toBe("issuer");
  });
  it("does not silently treat malformed IDs as missing", () => {
    expect(() => taskSessionMetadata({ issued_by_session_id: 123 })).toThrow("Invalid Actio session metadata");
  });
});
