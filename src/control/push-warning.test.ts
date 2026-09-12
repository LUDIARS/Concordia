import { describe, expect, it } from "vitest";
import { isWarningRemoteAllowed, PushWarningSchema, pushWarningText } from "./push-warning.js";

const push = { remoteName: "origin", remoteUrl: "https://github.com/LUDIARS/Example.git",
  updates: [{ localRef: "refs/heads/rewrite", localSha: "a".repeat(40), remoteRef: "refs/heads/main", remoteSha: "b".repeat(40) }] };

describe("WARNING operation envelope", () => {
  it("includes the complete target and resolved old/new object IDs", () => {
    const parsed = PushWarningSchema.parse(push);
    const text = pushWarningText({ sessionId: "session-1", repoPath: "E:/Ars/Example", branch: "feat/rewrite", push: parsed });
    for (const value of ["WARNING", "session-1", "E:/Ars/Example", "feat/rewrite", push.remoteUrl,
      "refs/heads/main", "a".repeat(40), "b".repeat(40)]) expect(text).toContain(value);
  });
  it("rejects injected approval fields, duplicate refs and control characters", () => {
    expect(PushWarningSchema.safeParse({ ...push, approved: true }).success).toBe(false);
    expect(PushWarningSchema.safeParse({ ...push, updates: [...push.updates, ...push.updates] }).success).toBe(false);
    expect(PushWarningSchema.safeParse({ ...push, remoteUrl: push.remoteUrl + "\nother" }).success).toBe(false);
    expect(PushWarningSchema.safeParse({ ...push, updates: [] }).success).toBe(false);
  });
  it("never displays credentials or substitutes a different remote", () => {
    expect(isWarningRemoteAllowed(push.remoteUrl, push.remoteUrl)).toBe(true);
    expect(isWarningRemoteAllowed(push.remoteUrl, "https://github.com/Other/Repo.git")).toBe(false);
    for (const remote of ["https://secret@github.com/A/B", "file:///tmp/repo", "https://github.com/A/B?token=secret"]) {
      expect(isWarningRemoteAllowed(remote, remote)).toBe(false);
    }
  });
});
