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
    expect(isContractComplete(contract)).toBe(true);
  });
  it("rejects untyped LLM-shaped values", () => {
    expect(SessionContractSchema.safeParse({ version: 1, mode: { value: "magic" } }).success).toBe(false);
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

  it("keeps team undecided when a repository has multiple candidates", async () => {
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
      () => [{ id: "team-a", name: "A" }, { id: "team-b", name: "B" }],
    );

    const contract = parseContractMetadata(sessions.findSession("multi-team-session")?.metadata ?? null);
    expect(contract?.team).toBeNull();
    expect(isContractComplete(contract)).toBe(false);
  });
});
