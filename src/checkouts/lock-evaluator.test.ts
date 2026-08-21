import { describe, expect, it } from "vitest";
import { evaluateCheckoutLock } from "./lock-evaluator.js";
import type { SessionRow } from "../shared/types.js";
import type { TestClaimRow } from "../db/testing-claims-repo.js";

const WORKSPACE_ROOTS = ["E:/Document/Ars"];
const QUERY = {
  repo_origin: "LUDIARS/Concordia",
  repo_path: "E:/Document/Ars/Concordia",
  branch: "main",
};

function session(overrides: Partial<SessionRow> & { id: string }): SessionRow {
  return {
    provider: "claude-code",
    repo_path: "E:/Document/Ars/Concordia",
    repo_origin: "LUDIARS/Concordia",
    branch: "feat/x",
    host: "test-host",
    started_at: 100,
    ended_at: null,
    status: "active",
    last_seen_at: 100,
    current_task: "task md の実装",
    transcript_path: null,
    metadata: null,
    ws_clients: 0,
    target_project: null,
    ...overrides,
  } as SessionRow;
}

function claim(overrides: Partial<TestClaimRow> = {}): TestClaimRow {
  return {
    id: 1,
    service: "concordia",
    session_id: "s-test",
    branch: "main",
    note: "起動テスト中",
    started_at: 200,
    released_at: null,
    ...overrides,
  };
}

function evaluate(input: { sessions?: SessionRow[]; claims?: TestClaimRow[] }) {
  return evaluateCheckoutLock({
    query: QUERY,
    sessions: input.sessions ?? [],
    claims: input.claims ?? [],
    workspaceRoots: WORKSPACE_ROOTS,
  });
}

describe("evaluateCheckoutLock", () => {
  it("掴み手が居なければ許可する", () => {
    expect(evaluate({})).toEqual({ allowed: true });
  });

  it("その checkout を掴んでいる active session があれば session_active で拒否する", () => {
    const result = evaluate({ sessions: [session({ id: "s-1" })] });
    expect(result).toMatchObject({ allowed: false, reason: "session_active" });
    if (result.allowed) throw new Error("unreachable");
    // 人が次の手を決められる情報 (誰が・何を・どの branch) を返す。
    expect(result.holders[0]).toMatchObject({
      kind: "session",
      session_id: "s-1",
      task: "task md の実装",
      branch: "feat/x",
      repo_path: "E:/Document/Ars/Concordia",
    });
  });

  it("終了済み session は掴み手に数えない", () => {
    expect(evaluate({ sessions: [session({ id: "s-1", status: "ended" })] })).toEqual({ allowed: true });
  });

  it("ワークスペースルートに居るだけの umbrella session は掴み手にしない", () => {
    const umbrella = session({
      id: "s-root",
      repo_path: "E:/Document/Ars",
      repo_origin: null,
      branch: "main",
    });
    expect(evaluate({ sessions: [umbrella] })).toEqual({ allowed: true });
  });

  it("umbrella でも target_project を宣言していれば掴み手になる", () => {
    const declared = session({
      id: "s-root",
      repo_path: "E:/Document/Ars",
      repo_origin: null,
      target_project: "E:\\Document\\Ars\\Concordia",
    });
    expect(evaluate({ sessions: [declared] })).toMatchObject({ allowed: false, reason: "session_active" });
  });

  it("その repo のサービスに testing claim が出ていれば testing_claim_active で拒否する", () => {
    const result = evaluate({ claims: [claim()] });
    expect(result).toMatchObject({ allowed: false, reason: "testing_claim_active" });
    if (result.allowed) throw new Error("unreachable");
    expect(result.holders[0]).toMatchObject({
      kind: "testing_claim",
      session_id: "s-test",
      service: "concordia",
      note: "起動テスト中",
    });
  });

  it("claim した session が repo を掴んでいれば service 名が違っても拒否する", () => {
    const holder = session({ id: "s-2", repo_path: "E:/Document/Ars/Concordia" });
    const result = evaluate({ sessions: [holder], claims: [claim({ session_id: "s-2", service: "cc-web" })] });
    expect(result).toMatchObject({ allowed: false, reason: "session_active" });
    if (result.allowed) throw new Error("unreachable");
    expect(result.holders.map((h) => h.kind)).toContain("testing_claim");
  });

  it("別 repo のサービスの testing claim では拒否しない", () => {
    const other = session({ id: "s-3", repo_path: "E:/Document/Ars/Memoria", repo_origin: "LUDIARS/Memoria" });
    const result = evaluate({ sessions: [other], claims: [claim({ session_id: "s-3", service: "memoria" })] });
    expect(result).toEqual({ allowed: true });
  });

  it("対象 branch を作業中として登録している別 worktree の session は branch_in_use で拒否する", () => {
    const worktree = session({
      id: "s-4",
      repo_path: "E:/Document/Ars/.wt-Concordia-x",
      branch: "refs/heads/main",
    });
    const result = evaluate({ sessions: [worktree] });
    expect(result).toMatchObject({ allowed: false, reason: "branch_in_use" });
    if (result.allowed) throw new Error("unreachable");
    expect(result.holders).toHaveLength(1);
    expect(result.holders[0].session_id).toBe("s-4");
  });

  it("同 repo でも別 branch の worktree session だけなら許可する", () => {
    const worktree = session({
      id: "s-5",
      repo_path: "E:/Document/Ars/.wt-Concordia-y",
      branch: "feat/other",
      repo_origin: null,
    });
    expect(evaluate({ sessions: [worktree] })).toEqual({ allowed: true });
  });
});
