import { describe, expect, it } from "vitest";
import {
  LocalGitError, describeCacheFailure, describeCcFailure, describeLocalGitFailure, fallbackDenyReason,
  formatFailures, invalidResponseFailure,
} from "./gate-failure.js";
import { snapshotUnusableReason, usableSnapshot, type LocalPolicySnapshot } from "./supervisor-policy.js";
import type { HarnessAction } from "./predicates.js";

const NOW = 1_000_000_000;
const action: HarnessAction = { tool: "Bash", command: "npm test", cwd: "E:/repo", branch: "feat/x" };
const snapshot = (patch: Partial<LocalPolicySnapshot> = {}): LocalPolicySnapshot => ({
  version: 1, capturedAt: NOW - 1000, sessionId: "s-1", repo: "E:/repo", branch: "feat/x", context: {},
  policy: { ddd: false, contract: false }, mainPushAllowlist: [], strongImplModels: [], editedRepos: [], editedFiles: [],
  ...patch,
});

describe("describeCcFailure", () => {
  it("classifies offline, slow and 5xx; 2xx-4xx is not a Cc failure", () => {
    expect(describeCcFailure({ kind: "offline" })?.kind).toBe("cc_unreachable");
    expect(describeCcFailure({ kind: "slow" })?.kind).toBe("cc_slow");
    expect(describeCcFailure({ kind: "online", response: { status: 200, body: {} } })).toBeNull();
    expect(describeCcFailure({ kind: "online", response: { status: 404, body: {} } })).toBeNull();
  });

  it("keeps the 5xx error code and reason, or falls back to the HTTP status", () => {
    const withBody = describeCcFailure({ kind: "online",
      response: { status: 500, body: { error: "implementation_bind_failed", reason: "unnamed_branch" } } });
    expect(withBody).toEqual({ kind: "cc_error", message: "Cc gate returned HTTP 500 (implementation_bind_failed: unnamed_branch)" });
    expect(describeCcFailure({ kind: "online", response: { status: 503, body: null } })?.message).toBe("Cc gate returned HTTP 503");
  });
});

describe("invalidResponseFailure", () => {
  it("names the status of the malformed answer", () => {
    expect(invalidResponseFailure(200, { foo: 1 })).toEqual({ kind: "cc_invalid_response", message: "Cc returned an invalid gate response (HTTP 200)" });
    expect(invalidResponseFailure(400, { error: "invalid_body" }).message).toContain("HTTP 400, invalid_body");
  });
});

describe("cache diagnosis", () => {
  it("separates expired, session, branch and corrupt caches and agrees with usableSnapshot", () => {
    expect(snapshotUnusableReason(snapshot(), action, "s-1", NOW)).toBeNull();
    expect(usableSnapshot(snapshot(), action, "s-1", NOW)).toBe(true);
    const cases: Array<[unknown, string, string]> = [
      [snapshot({ capturedAt: NOW - 16 * 60_000 }), "s-1", "expired"],
      [snapshot({ capturedAt: NOW + 1 }), "s-1", "expired"],
      [snapshot(), "s-2", "session_mismatch"],
      [snapshot(), "", "session_mismatch"],
      [snapshot({ branch: "main" }), "s-1", "branch_mismatch"],
      [snapshot({ repo: "E:/other" }), "s-1", "corrupt"],
      [{ version: 1 }, "s-1", "corrupt"],
      [undefined, "s-1", "corrupt"],
    ];
    for (const [value, session, reason] of cases) {
      expect(snapshotUnusableReason(value, action, session, NOW)).toBe(reason);
      expect(usableSnapshot(value, action, session, NOW)).toBe(false);
    }
  });

  it("maps the diagnosis to failure kinds and reports a missing file", () => {
    expect(describeCacheFailure(false, "corrupt")?.kind).toBe("cache_missing");
    expect(describeCacheFailure(true, "expired")?.kind).toBe("cache_expired");
    expect(describeCacheFailure(true, "session_mismatch")?.kind).toBe("cache_session_mismatch");
    expect(describeCacheFailure(true, "branch_mismatch")?.kind).toBe("cache_branch_mismatch");
    expect(describeCacheFailure(true, "corrupt")?.kind).toBe("cache_corrupt");
    expect(describeCacheFailure(true, null)).toBeNull();
  });
});

describe("local git failures", () => {
  it("names the git operation and whether it timed out or exited", () => {
    const timeout = new LocalGitError("rev-parse --show-toplevel", Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }));
    expect(describeLocalGitFailure(timeout)).toEqual({ kind: "local_git_failed",
      message: "local `git rev-parse --show-toplevel` timed out inside the hook" });
    const exit = new LocalGitError("branch --show-current", Object.assign(new Error("Command failed"), { status: 128 }));
    expect(exit.status).toBe(128);
    expect(describeLocalGitFailure(exit).message).toContain("exit code 128");
    const missing = new LocalGitError("rev-parse --git-dir", Object.assign(new Error("spawnSync git ENOENT"), { code: "ENOENT" }));
    expect(describeLocalGitFailure(missing).message).toContain("git executable not found");
  });
});

describe("supervisor-cli denial wording", () => {
  it("prints both causes for unreachable Cc with an expired cache", () => {
    const reason = fallbackDenyReason([describeCcFailure({ kind: "offline" })!, describeCacheFailure(true, "expired")!]);
    expect(reason).toMatch(/^\[cc_unreachable\] .+ \/ \[cache_expired\] .+\. Reconnect to Cc to refresh the policy cache\.$/);
  });

  it("asks for a retry only when Cc is slow and no cache exists", () => {
    const slow = fallbackDenyReason([describeCcFailure({ kind: "slow" })!, describeCacheFailure(false, null)!]);
    expect(slow).toContain("[cc_slow]");
    expect(slow).toContain("[cache_missing]");
    expect(slow.endsWith("Retry the command.")).toBe(true);
    const down = fallbackDenyReason([describeCcFailure({ kind: "offline" })!, describeCacheFailure(false, null)!]);
    expect(down.endsWith("Only configured recovery roots and commands are permitted.")).toBe(true);
  });

  it("carries the 5xx body into the denial next to a branch-mismatched cache", () => {
    const reason = fallbackDenyReason([
      describeCcFailure({ kind: "online", response: { status: 500, body: { error: "internal" } } })!,
      describeCacheFailure(true, "branch_mismatch")!,
    ]);
    expect(reason).toContain("[cc_error] Cc gate returned HTTP 500 (internal)");
    expect(reason).toContain("[cache_branch_mismatch]");
  });

  it("formats failures as [kind] message joined by slashes", () => {
    expect(formatFailures([{ kind: "cc_slow", message: "a" }, { kind: "cache_missing", message: "b" }])).toBe("[cc_slow] a / [cache_missing] b");
  });
});
