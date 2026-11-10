import { describe, expect, it } from "vitest";
import {
  branchedCheckouts,
  decideRepoAgentHandoff,
  isRepoMismatchDenial,
  launchCheckoutOf,
  resolveCheckout,
  resolveRegisteredRepo,
  type RepoAgentHandoffInput,
} from "./repo-agent-policy.js";
import { isDelegatedSession, isRepoAgentSession, parseSessionMetadata } from "./managed-session.js";

const REGISTERED = ["E:/Document/Ars/Concordia", "E:/Document/Ars/Memoria", "E:\\Document\\Ars\\Revisor\\"];
const SETTINGS = { enabled: true, maxAgentsPerParent: 3 };

describe("isRepoMismatchDenial (§3.1, INV-6)", () => {
  it.each(["task-branch", "contract-incomplete", "outside-scope", "max-repos"])("%s の deny は契機", (rule) => {
    expect(isRepoMismatchDenial({ rule, decision: "deny" })).toBe(true);
  });

  it("warn は契機にしない", () => {
    expect(isRepoMismatchDenial({ rule: "outside-scope", decision: "warn" })).toBe(false);
  });

  it.each(["no-main-push", "consultation-secret", "bash-known-hazard", "inquiry-read-only", "usage-budget", "strong-model-impl"])(
    "安全上の rule %s は契機にしない", (rule) => {
      expect(isRepoMismatchDenial({ rule, decision: "deny" })).toBe(false);
    },
  );
});

describe("checkout の解決", () => {
  it("最長一致の登録リポへ寄せ、 区切り・大小・末尾 / を無視する", () => {
    expect(resolveRegisteredRepo("e:\\document\\ars\\concordia\\src\\x.ts", REGISTERED)).toBe("E:/Document/Ars/Concordia");
    expect(resolveRegisteredRepo("E:/Document/Ars/Revisor", REGISTERED)).toBe("E:/Document/Ars/Revisor");
    expect(resolveRegisteredRepo("E:/Document/Ars/ConcordiaX", REGISTERED)).toBeNull();
  });

  it("worktree (<repo>/.wt-*) はその worktree を checkout にする", () => {
    expect(resolveCheckout("E:/Document/Ars/Concordia/.wt-x/src/a.ts", REGISTERED)).toEqual({
      checkout: "E:/Document/Ars/Concordia/.wt-x", repo: "E:/Document/Ars/Concordia",
    });
    expect(resolveCheckout("E:/Document/Ars/Concordia/src/a.ts", REGISTERED)).toEqual({
      checkout: "E:/Document/Ars/Concordia", repo: "E:/Document/Ars/Concordia",
    });
    expect(resolveCheckout("E:/Document/Ars/Unknown/a.ts", REGISTERED)).toBeNull();
  });

  it("登録外の起動 cwd (ワークスペースルート) はそのまま起動 checkout になる", () => {
    expect(launchCheckoutOf("E:\\Document\\Ars", REGISTERED)).toBe("E:/Document/Ars");
    expect(launchCheckoutOf("E:/Document/Ars/Concordia/.wt-a", REGISTERED)).toBe("E:/Document/Ars/Concordia/.wt-a");
  });
});

function handoff(overrides: Partial<RepoAgentHandoffInput> = {}): RepoAgentHandoffInput {
  return {
    parentStatus: "active",
    spawnable: true,
    managedElsewhere: false,
    launchCheckout: "E:/Document/Ars",
    target: resolveCheckout("E:/Document/Ars/Concordia/.wt-x/src/a.ts", REGISTERED),
    agents: [],
    sessionEnding: false,
    ...overrides,
  };
}

describe("decideRepoAgentHandoff (§3.2)", () => {
  it("起動 cwd と違う登録 checkout なら担当を立てる", () => {
    expect(decideRepoAgentHandoff(handoff(), SETTINGS)).toEqual({
      action: "assign", target: { checkout: "E:/Document/Ars/Concordia/.wt-x", repo: "E:/Document/Ars/Concordia" },
    });
  });

  it("起動 cwd と同じ checkout は same_checkout (大小・区切りの違いは同じ扱い)", () => {
    expect(decideRepoAgentHandoff(handoff({ launchCheckout: "e:\\document\\ars\\concordia\\.wt-x" }), SETTINGS))
      .toEqual({ action: "skip", reason: "same_checkout" });
  });

  it("同じリポの別 worktree は別 checkout として担当を立てる", () => {
    expect(decideRepoAgentHandoff(handoff({ launchCheckout: "E:/Document/Ars/Concordia/.wt-y" }), SETTINGS).action).toBe("assign");
  });

  it("未登録リポは unregistered", () => {
    expect(decideRepoAgentHandoff(handoff({ target: null }), SETTINGS)).toEqual({ action: "skip", reason: "unregistered" });
  });

  it("生きた担当がいる checkout は already_assigned、 終端の行は数えない", () => {
    expect(decideRepoAgentHandoff(handoff({ agents: [{ checkout: "E:/Document/Ars/Concordia/.wt-x", status: "active" }] }), SETTINGS))
      .toEqual({ action: "skip", reason: "already_assigned" });
    expect(decideRepoAgentHandoff(handoff({ agents: [{ checkout: "E:/Document/Ars/Concordia/.wt-x", status: "ended" }] }), SETTINGS).action)
      .toBe("assign");
  });

  it("担当数が上限に達していれば agent_limit", () => {
    const agents = ["a", "b", "c"].map((name) => ({ checkout: `E:/Document/Ars/Memoria/.wt-${name}`, status: "requested" }));
    expect(decideRepoAgentHandoff(handoff({ agents }), SETTINGS)).toEqual({ action: "skip", reason: "agent_limit" });
  });

  it.each([
    ["disabled", handoff(), { ...SETTINGS, enabled: false }],
    ["not_spawnable", handoff({ spawnable: false }), SETTINGS],
    ["not_spawnable", handoff({ parentStatus: "ended" }), SETTINGS],
    ["managed_elsewhere", handoff({ managedElsewhere: true }), SETTINGS],
    ["session_ending", handoff({ sessionEnding: true }), SETTINGS],
  ] as const)("%s で skip", (reason, value, settings) => {
    expect(decideRepoAgentHandoff(value, settings)).toEqual({ action: "skip", reason });
  });
});

describe("再帰防止の判定 (managed-session)", () => {
  it("委託子・パートタイマー (delegation run 由来) とリポ担当を見分ける", () => {
    expect(isDelegatedSession(parseSessionMetadata(JSON.stringify({ delegation_run_id: "r1" })))).toBe(true);
    expect(isDelegatedSession(parseSessionMetadata(JSON.stringify({ delegation_parent_session_id: "p" })))).toBe(true);
    expect(isRepoAgentSession(parseSessionMetadata(JSON.stringify({ repo_agent_of: { parent_session_id: "p", checkout: "c" } })))).toBe(true);
    expect(isDelegatedSession(parseSessionMetadata("not json"))).toBe(false);
    expect(isRepoAgentSession(parseSessionMetadata(null))).toBe(false);
  });
});

describe("branchedCheckouts (§3.1 02b)", () => {
  it("起動 checkout・ワークスペースルート・未登録・重複を除いた登録 checkout を返す", () => {
    expect(branchedCheckouts({
      launchCheckout: "E:/Document/Ars/Concordia/.wt-a",
      activeRepos: [
        "E:/Document/Ars",
        "E:/Document/Ars/Concordia/.wt-a",
        "E:/Document/Ars/Memoria",
        "e:\\document\\ars\\memoria",
        "E:/Document/Ars/Unknown",
        "E:/Document/Ars/Concordia/.wt-b",
      ],
      registeredRepos: REGISTERED,
      workspaceRoots: ["E:/Document/Ars"],
    })).toEqual([
      { checkout: "E:/Document/Ars/Memoria", repo: "E:/Document/Ars/Memoria" },
      { checkout: "E:/Document/Ars/Concordia/.wt-b", repo: "E:/Document/Ars/Concordia" },
    ]);
  });
});
