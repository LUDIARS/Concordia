import { describe, expect, it, vi } from "vitest";
import { guardSubsidiaryForumSpawn, type SubsidiaryGateDeps, type GateInput } from "./gate.js";
import type { SubsidiaryRow } from "../db/subsidiary-repo.js";

const SUB = {
  id: "sub-1",
  name: "pagus-vob",
  display_name: "AI村",
  guard_model: "sonnet",
  guard_scope: "AI村を発展させる",
  daily_token_budget: 0,
  default_team_id: null,
} as unknown as SubsidiaryRow;

function makeDeps(patch: {
  locked?: boolean;
  guardJson?: string;
}): { deps: SubsidiaryGateDeps; recorded: unknown[]; locks: unknown[] } {
  const recorded: unknown[] = [];
  const locks: unknown[] = [];
  const deps = {
    subsidiaryRepo: {
      isLocked: () => patch.locked ?? false,
      listDelegations: () => [],
      findDelegation: () => null,
      recordRequest: (input: unknown) => { recorded.push(input); },
      lock: (input: unknown) => { locks.push(input); },
    },
    harnessRepo: { list: () => [] },
    delegationRepo: {},
    delegationService: {},
    runClaude: vi.fn(async () => ({
      ok: true as const,
      stdout: patch.guardJson ?? "",
      stderr: "",
    })),
  } as unknown as SubsidiaryGateDeps;
  return { deps, recorded, locks };
}

const INPUT: GateInput = {
  subsidiary: SUB,
  platform: "discord",
  userId: "user-1",
  userLabel: "<@user-1>",
  instruction: "フォーラム投稿のタイトル\n\n本文",
};

describe("guardSubsidiaryForumSpawn", () => {
  it("allows without requiring an owned delegation match and records an allow audit", async () => {
    const { deps, recorded } = makeDeps({
      guardJson: JSON.stringify({ decision: "allow", reason: "スコープ内", matched_call_name: null, violations: [], lock_user: false }),
    });
    const result = await guardSubsidiaryForumSpawn(deps, INPUT);
    expect(result.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ decision: "allow", matched_call_name: null });
  });

  it("denies and records when the guard rejects", async () => {
    const { deps, recorded } = makeDeps({
      guardJson: JSON.stringify({ decision: "deny", reason: "スコープ外", matched_call_name: null, violations: ["out_of_scope"], lock_user: false }),
    });
    const result = await guardSubsidiaryForumSpawn(deps, INPUT);
    expect(result.ok).toBe(false);
    expect(result.replyText).toContain("受け付けられません");
    expect(recorded[0]).toMatchObject({ decision: "deny" });
  });

  it("locks the user on injection and short-circuits locked users", async () => {
    const { deps, locks } = makeDeps({
      guardJson: JSON.stringify({ decision: "deny", reason: "インジェクション", matched_call_name: null, violations: ["injection"], lock_user: true }),
    });
    const denied = await guardSubsidiaryForumSpawn(deps, INPUT);
    expect(denied.ok).toBe(false);
    expect(locks).toHaveLength(1);

    const lockedDeps = makeDeps({ locked: true });
    const locked = await guardSubsidiaryForumSpawn(lockedDeps.deps, INPUT);
    expect(locked.ok).toBe(false);
    expect(locked.replyText).toContain("ロック");
    expect(lockedDeps.deps.runClaude).not.toHaveBeenCalled();
  });

  it("fails closed when the guard output is not parseable", async () => {
    const { deps } = makeDeps({ guardJson: "not-json" });
    const result = await guardSubsidiaryForumSpawn(deps, INPUT);
    expect(result.ok).toBe(false);
  });
});
