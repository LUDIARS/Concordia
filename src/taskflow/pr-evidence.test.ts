import { describe, expect, it } from "vitest";
import { mergeTaskPrEvidence, type TaskPrEvidence } from "./pr-evidence.js";

export const evidence: TaskPrEvidence = { provider: "revisor", repository: "LUDIARS/Concordia", id: "pr-1", number: 1,
  url: null, head_sha: "a", reviewed_head_sha: "a", state: "open", review: "test_ok", reflection: "unknown", observed_at: "2026-09-26T00:00:00.000Z" };

describe("PR evidence", () => {
  it("preserves session provenance and distinguishes same-number repositories/providers", () => {
    const initial = { issued_by_session_id: "issuer", working_session_id: "worker" };
    const first = mergeTaskPrEvidence(initial, evidence);
    const second = mergeTaskPrEvidence(first, { ...evidence, repository: "LUDIARS/Actio" });
    const third = mergeTaskPrEvidence(second, { ...evidence, provider: "github" });
    expect(third).toMatchObject(initial);
    expect(third.pull_requests).toHaveLength(3);
  });
  it("invalidates review on a different head", () => {
    expect(mergeTaskPrEvidence(null, { ...evidence, reviewed_head_sha: "old" }).pull_requests)
      .toEqual([expect.objectContaining({ review: "stale", reflection: "unknown" })]);
  });
  it("does not overwrite a newer observation", () => {
    const newer = mergeTaskPrEvidence(null, { ...evidence, state: "merged", observed_at: "2026-09-27T00:00:00.000Z" });
    expect(mergeTaskPrEvidence(newer, evidence)).toBe(newer);
  });
  it("keeps reflection for the same head only", () => {
    const prior = mergeTaskPrEvidence(null, { ...evidence, reflection: "verified" });
    expect(mergeTaskPrEvidence(prior, evidence).pull_requests).toEqual([expect.objectContaining({ reflection: "verified" })]);
    expect(mergeTaskPrEvidence(prior, { ...evidence, head_sha: "b" }).pull_requests).toEqual([expect.objectContaining({ reflection: "unknown" })]);
  });
});
