import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { parseContractMetadata } from "./schema.js";
import { seedSessionContract } from "./seed-rules.js";
import { patchContractHuman, saveContract } from "./store.js";

function insertWithContract(sessions: SessionsRepo, id: string): void {
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
    metadata: JSON.stringify({ model: "gpt-5-codex", effort_level: "medium" }),
  } as SessionRow;
  sessions.insertSession({ ...row, active_repos: [] });
  saveContract(sessions, id, seedSessionContract(row, "small fix", "discord:1"), "spawn-or-first-instruction", 1);
}

describe("patchContractHuman", () => {
  it("overrides fields as human decisions and records an audit event", () => {
    const sessions = new SessionsRepo(makeTestDb());
    insertWithContract(sessions, "s-patch");

    const updated = patchContractHuman(sessions, "s-patch", { effort: "high" }, "人間の判断で high に固定");
    expect(updated?.effort).toMatchObject({ value: "high", decided_by: "human", rationale: "人間の判断で high に固定" });
    // 他フィールドは元の決定のまま。
    expect(updated?.model).toMatchObject({ value: "gpt-5-codex", decided_by: "seed" });

    const persisted = parseContractMetadata(sessions.findSession("s-patch")?.metadata ?? null);
    expect(persisted?.effort).toMatchObject({ value: "high", decided_by: "human" });
    const events = sessions.eventsByKind("s-patch", "contract");
    expect(events.some((event) => (JSON.parse(event.payload) as { reason?: string }).reason === "human-override")).toBe(true);
  });

  it("returns null when the session or contract is missing", () => {
    const sessions = new SessionsRepo(makeTestDb());
    expect(patchContractHuman(sessions, "missing", { effort: "high" }, "test")).toBeNull();
  });
});
