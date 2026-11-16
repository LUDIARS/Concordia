import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_AT_KEY,
  CONFIRMATION_BASELINE_KEY,
  CONFIRMATION_KEY,
  CONFIRMATION_RELEASE_KEY,
  decideConfirmationRelease,
  releaseConfirmationOnActivity,
  type ConfirmationActivity,
} from "./human-response-activity-release.js";

const quiet: ConfirmationActivity = { head: "aaa", headCommittedAt: 100, prs: ["5:sha1"] };

function repoWith(metadata: Record<string, unknown>) {
  const state = { metadata };
  return {
    state,
    updateMetadata: (_id: string, update: (current: Record<string, unknown>) => Record<string, unknown>) => {
      state.metadata = update(state.metadata);
    },
  };
}

describe("human response confirmation release by observed activity", () => {
  it("leaves sessions that are not waiting untouched", () => {
    expect(decideConfirmationRelease({}, quiet)).toEqual({ kind: "keep" });
  });

  it("releases on a commit made after the confirmation was claimed", () => {
    const waiting = { [CONFIRMATION_KEY]: true, [CONFIRMATION_AT_KEY]: 150 };
    expect(decideConfirmationRelease(waiting, { ...quiet, headCommittedAt: 200 })).toEqual({ kind: "release", reason: "確認の後に新しいコミット" });
    expect(decideConfirmationRelease(waiting, quiet)).toEqual({ kind: "baseline", baseline: { head: "aaa", prs: ["5:sha1"] } });
  });

  it("records a baseline first, then releases on a new HEAD or a submitted/updated PR but not on a PR leaving the list", () => {
    const waiting = { [CONFIRMATION_KEY]: true, [CONFIRMATION_BASELINE_KEY]: { head: "aaa", prs: ["5:sha1"] } };
    expect(decideConfirmationRelease(waiting, quiet)).toEqual({ kind: "keep" });
    expect(decideConfirmationRelease(waiting, { ...quiet, head: "bbb" })).toMatchObject({ kind: "release", reason: "確認の後に HEAD が変化" });
    expect(decideConfirmationRelease(waiting, { ...quiet, prs: ["5:sha2"] })).toMatchObject({ kind: "release" });
    expect(decideConfirmationRelease(waiting, { ...quiet, prs: [] })).toEqual({ kind: "keep" });
  });

  it("does not compare what could not be observed", () => {
    const waiting = { [CONFIRMATION_KEY]: true, [CONFIRMATION_BASELINE_KEY]: { head: "aaa", prs: ["5:sha1"] } };
    expect(decideConfirmationRelease(waiting, { head: null, headCommittedAt: null, prs: null })).toEqual({ kind: "keep" });
  });

  it("writes the baseline, then clears the flag with the reason when the session moves", () => {
    const repo = repoWith({ [CONFIRMATION_KEY]: true });
    expect(releaseConfirmationOnActivity(repo, "s", quiet, 300)).toBeNull();
    expect(repo.state.metadata[CONFIRMATION_BASELINE_KEY]).toEqual({ head: "aaa", prs: ["5:sha1"] });
    expect(releaseConfirmationOnActivity(repo, "s", { ...quiet, head: "bbb" }, 400)).toBe("確認の後に HEAD が変化");
    expect(repo.state.metadata).toMatchObject({
      [CONFIRMATION_KEY]: false,
      [CONFIRMATION_BASELINE_KEY]: null,
      [CONFIRMATION_RELEASE_KEY]: { at: 400, by: "observed_activity", reason: "確認の後に HEAD が変化" },
    });
  });
});
