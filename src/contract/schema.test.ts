import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { ensureSessionContract } from "./lifecycle.js";
import { isContractComplete, parseContractMetadata, SessionContractSchema } from "./schema.js";
import { seedSessionContract } from "./seed-rules.js";

describe("session contract", () => {
  it("deterministically seeds risky work as plan", () => {
    const session = { provider: "codex-cli", repo_path: "E:/repo", branch: "feat/x", metadata: "{}", target_project: "Cc" } as SessionRow;
    const contract = seedSessionContract(session, "schema migration", "discord:1");
    expect(contract.mode?.value).toBe("plan");
    expect(contract.work_location?.value).toBe("worktree");
    expect(contract.goal_and_go?.value).toEqual({ enabled: true });
    // runtime が model / effort を報告していないので seed では決まらない (LLM/human tier 行き)。
    expect(contract.model).toBeNull();
    expect(contract.effort).toBeNull();
    expect(isContractComplete(contract)).toBe(false);
  });

  it("preserves an explicit goal-and-go opt-out in the session contract", () => {
    const session = {
      provider: "codex-cli",
      repo_path: "E:/repo",
      branch: "feat/x",
      metadata: JSON.stringify({ goal_and_go: { enabled: false } }),
      target_project: "Cc",
    } as SessionRow;
    expect(seedSessionContract(session, "small fix", "discord:1").goal_and_go?.value)
      .toEqual({ enabled: false });
  });

  it("seeds model/effort only from actually reported runtime metadata", () => {
    const session = {
      provider: "codex-cli",
      repo_path: "E:/repo",
      branch: "feat/x",
      metadata: JSON.stringify({ model: "gpt-5.3-codex", effort_level: "high" }),
      target_project: "Cc",
    } as SessionRow;
    const contract = seedSessionContract(session, "schema migration", "discord:1");
    expect(contract.model).toMatchObject({ value: "gpt-5.3-codex", decided_by: "seed" });
    expect(contract.effort).toMatchObject({ value: "high", decided_by: "seed" });
    expect(isContractComplete(contract)).toBe(true);
  });
  it("prefers runtime-switch effort metadata over the launch-time effort", () => {
    const session = {
      provider: "codex-cli",
      repo_path: "E:/repo",
      branch: "feat/x",
      metadata: JSON.stringify({ model: "gpt-5.3-codex", effort_level: "medium", effort: "high" }),
      target_project: "Cc",
    } as SessionRow;
    const contract = seedSessionContract(session, "schema migration", "discord:1");
    expect(contract.effort).toMatchObject({ value: "high", decided_by: "seed" });
  });
  it("rejects untyped LLM-shaped values", () => {
    expect(SessionContractSchema.safeParse({ version: 1, mode: { value: "magic" } }).success).toBe(false);
  });

  it("team settings worktree=repo-root-only overrides plan mode's default worktree location", () => {
    const session = { provider: "codex-cli", repo_path: "E:/repo", branch: "feat/x", metadata: "{}", target_project: "Cc" } as SessionRow;
    const contract = seedSessionContract(session, "schema migration", "discord:1", "team-unity", { worktree: "repo-root-only" });
    expect(contract.work_location?.value).toBe("repo-root");
  });

  it("team-unset sessions keep the existing plan-mode worktree default (fallback)", () => {
    const session = { provider: "codex-cli", repo_path: "E:/repo", branch: "feat/x", metadata: "{}", target_project: "Cc" } as SessionRow;
    const contract = seedSessionContract(session, "schema migration", "discord:1");
    expect(contract.work_location?.value).toBe("worktree");
  });

  it("seeds the explicitly persisted session team", () => {
    const session = {
      provider: "codex-cli",
      repo_path: "E:/repo",
      branch: "feat/x",
      metadata: "{}",
      target_project: "Cc",
      team_id: "team_explicit",
    } as SessionRow;
    expect(seedSessionContract(session, "small fix", "discord:1", session.team_id).team?.value)
      .toBe("team_explicit");
  });

  it("keeps team undecided when a repository has multiple candidates, without blocking the contract", async () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    sessions.insertSession({
      id: "multi-team-session",
      provider: "codex-cli",
      repo_path: "E:/repo",
      repo_origin: "LUDIARS/Concordia",
      branch: "feat/x",
      host: "test-host",
      started_at: 1,
      last_seen_at: 1,
      transcript_path: null,
      metadata: null,
    });

    await ensureSessionContract(
      sessions,
      "multi-team-session",
      "small fix",
      "discord:1",
      undefined,
      undefined,
      () => [{ id: "team-a", name: "A", settings: {} }, { id: "team-b", name: "B", settings: {} }],
    );

    const contract = parseContractMetadata(sessions.findSession("multi-team-session")?.metadata ?? null);
    // チームは未確定のまま (どちらの候補も勝手に選ばない)。
    expect(contract?.team?.value).toBeNull();
    // ただし契約は成立させる。 未決のまま残すと contract-incomplete が編集を全 deny し、
    // 複数チーム repo だけ「カード待ちで止まる」 が復活する (2026-08-21 の撤廃対象)。
    expect(isContractComplete(contract)).toBe(true);
  });
});
