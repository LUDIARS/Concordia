import { describe, expect, it } from "vitest";
import { DEFAULT_PREDICATES } from "./predicates.js";
import { evaluateAction } from "./session-gate.js";
import { projectPredicates } from "./project-policy.js";
import { usableSnapshot, recoveryAllowed, type LocalPolicySnapshot } from "./supervisor-policy.js";

describe("project implementation policy", () => {
  // contract_enabled は「追加要件の opt-in」であって既存安全境界の opt-out ではない。
  // 既定 0 (= contract:false) のプロジェクトでも述語セットは削らない。
  it("keeps every baseline predicate regardless of the project opt-in state", () => {
    for (const policy of [{ ddd: false, contract: false }, { ddd: false, contract: true }, undefined]) {
      expect(projectPredicates(DEFAULT_PREDICATES, policy)).toHaveLength(DEFAULT_PREDICATES.length);
    }
  });

  it("still blocks vibes edits to schema/migration paths when contract is not opted in", () => {
    const predicates = projectPredicates(DEFAULT_PREDICATES, { ddd: false, contract: false });
    const vibes = { tool: "Edit", cwd: "/repo", contractMode: "vibes" as const, contractScopeDirs: ["src"] };
    // vibesScope は破壊的・schema・auth 編集を止める唯一の述語。 opt-in 未選択でも外れない。
    expect(evaluateAction({ ...vibes, filePath: "/repo/src/db/schema.ts" }, predicates).blocked).toBe(true);
    expect(evaluateAction({ ...vibes, filePath: "/repo/other/a.ts" }, predicates).blocked).toBe(true);
    expect(evaluateAction({ tool: "Bash", command: "git push origin main", branch: "main" }, predicates).blocked).toBe(true);
  });

  it("denies unresolved contracts only for opted-in projects", () => {
    const predicates = projectPredicates(DEFAULT_PREDICATES, { ddd: false, contract: true });
    // opt-in: gate handler が undefined を false へ倒すため deny になる。
    expect(evaluateAction({ tool: "Edit", filePath: "/repo/src/a.ts", contractComplete: false }, predicates).blocked).toBe(true);
    // 未選択: contractComplete は undefined のままなので追加要件は強制されない。
    expect(evaluateAction({ tool: "Edit", filePath: "/repo/src/a.ts" },
      projectPredicates(DEFAULT_PREDICATES, { ddd: false, contract: false })).blocked).toBe(false);
  });
});

describe("offline supervisor policy", () => {
  const snapshot: LocalPolicySnapshot = {
    version: 1, capturedAt: 1000, repo: "/repo", branch: "feature", sessionId: "session",
    context: {}, policy: { ddd: false, contract: true }, mainPushAllowlist: [], strongImplModels: [], editedRepos: [], editedFiles: [],
  };
  const action = { tool: "Edit", cwd: "/repo", branch: "feature", filePath: "/repo/src/a.ts" };
  it("rejects stale, future, other-session and other-branch snapshots", () => {
    expect(usableSnapshot(snapshot, action, "session", 2000)).toBe(true);
    expect(usableSnapshot(snapshot, action, "session", 1_000_000)).toBe(false);
    expect(usableSnapshot(snapshot, action, "session", 0)).toBe(false);
    expect(usableSnapshot(snapshot, action, "other", 2000)).toBe(false);
    expect(usableSnapshot(snapshot, { ...action, branch: "main" }, "session", 2000)).toBe(false);
  });
  it("limits recovery to explicit roots and exact commands", () => {
    expect(recoveryAllowed(action, ["/repo"], [])).toBe(true);
    expect(recoveryAllowed({ ...action, filePath: "/repo/../other/a.ts" }, ["/repo"], [])).toBe(false);
    expect(recoveryAllowed({ tool: "Bash", cwd: "/repo", command: "npm run build; git push origin main" }, ["/repo"], ["npm run build"])).toBe(false);
  });
});
