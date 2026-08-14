import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { applyContractModelEffort } from "./runtime-apply.js";
import type { SessionContract } from "./schema.js";
import { seedSessionContract } from "./seed-rules.js";
import type { SessionRow } from "../shared/types.js";

function decision<T>(value: T, decidedBy: "seed" | "llm" | "human") {
  return { value, decided_by: decidedBy, rationale: "test", genius_card_ids: [] };
}

function insertSession(sessions: SessionsRepo, id: string, metadata: Record<string, unknown> | null): SessionContract {
  const row = {
    id,
    provider: "codex-cli",
    repo_path: "E:/repo",
    repo_origin: "LUDIARS/Concordia",
    branch: "feat/x",
    host: "test-host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    metadata: metadata ? JSON.stringify(metadata) : null,
  } as SessionRow;
  sessions.insertSession({ ...row, active_repos: [] });
  return seedSessionContract(row, "small fix", "discord:1");
}

describe("applyContractModelEffort", () => {
  it("does not switch when both fields are seed decisions (already the runtime)", async () => {
    const sessions = new SessionsRepo(makeTestDb());
    const contract = insertSession(sessions, "s-seed", { model: "gpt-5.3-codex", effort_level: "high" });
    const apply = vi.fn();
    const result = await applyContractModelEffort({ sessions, sessionId: "s-seed", contract, apply });
    expect(result.applied).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("applies an llm decision that differs from the current runtime", async () => {
    const sessions = new SessionsRepo(makeTestDb());
    const contract = insertSession(sessions, "s-llm", { model: "gpt-5-codex", effort_level: "medium" });
    contract.effort = decision("high", "llm");
    const apply = vi.fn().mockResolvedValue({ ok: true, message: "switched" });
    const result = await applyContractModelEffort({ sessions, sessionId: "s-llm", contract, apply });
    expect(result).toMatchObject({ applied: true, ok: true });
    expect(apply).toHaveBeenCalledWith({ sessionId: "s-llm", model: "gpt-5-codex", effort: "high" });
  });

  it("does not switch when decisions already match the runtime values", async () => {
    const sessions = new SessionsRepo(makeTestDb());
    const contract = insertSession(sessions, "s-same", { model: "gpt-5-codex", effort_level: "high" });
    contract.effort = decision("high", "human");
    const apply = vi.fn();
    const result = await applyContractModelEffort({ sessions, sessionId: "s-same", contract, apply });
    expect(result.applied).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("skips the provider-name placeholder when the runtime model is unknown", async () => {
    const sessions = new SessionsRepo(makeTestDb());
    const contract = insertSession(sessions, "s-placeholder", null);
    contract.model = decision("codex-cli", "human");
    contract.effort = decision("medium", "human");
    const apply = vi.fn();
    const result = await applyContractModelEffort({ sessions, sessionId: "s-placeholder", contract, apply });
    expect(result.applied).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("does nothing while either field is still unresolved", async () => {
    const sessions = new SessionsRepo(makeTestDb());
    const contract = insertSession(sessions, "s-unresolved", null);
    contract.model = decision("gpt-5.3-codex", "llm");
    const apply = vi.fn();
    const result = await applyContractModelEffort({ sessions, sessionId: "s-unresolved", contract, apply });
    expect(result.applied).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("rejects settings that could inject input at the runtime command boundary", async () => {
    const sessions = new SessionsRepo(makeTestDb());
    const contract = insertSession(sessions, "s-unsafe", { model: "gpt-5-codex", effort_level: "medium" });
    contract.model = decision("gpt-5.3-codex\n/end-session", "human");
    contract.effort = decision("high", "human");
    const apply = vi.fn();
    const result = await applyContractModelEffort({ sessions, sessionId: "s-unsafe", contract, apply });
    expect(result).toMatchObject({ applied: false, ok: false });
    expect(apply).not.toHaveBeenCalled();
  });
});
