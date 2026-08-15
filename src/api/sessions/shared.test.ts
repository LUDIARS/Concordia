import { describe, expect, it } from "vitest";
import type { SessionRow } from "../../shared/types.js";
import { PatchSchema, serializeSession } from "./shared.js";

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "s1",
    provider: "codex-cli",
    repo_path: "E:/Document/Ars",
    repo_origin: "https://github.com/LUDIARS/Concordia",
    branch: "feat/x",
    host: "host",
    started_at: 1,
    ended_at: null,
    status: "active",
    last_seen_at: 2,
    current_task: null,
    transcript_path: null,
    metadata: null,
    ws_clients: 0,
    target_project: null,
    ...overrides,
  };
}

describe("serializeSession", () => {
  it("includes target_project", () => {
    expect(serializeSession(session({ target_project: "E:/Document/Ars/Lictor" }))).toMatchObject({
      target_project: "E:/Document/Ars/Lictor",
    });
    expect(serializeSession(session({ target_project: null }))).toMatchObject({
      target_project: null,
    });
  });
});

describe("PatchSchema", () => {
  it("accepts a transcript_path update or clearing it", () => {
    expect(PatchSchema.parse({ transcript_path: "/provider/sessions/a.jsonl" }))
      .toMatchObject({ transcript_path: "/provider/sessions/a.jsonl" });
    expect(PatchSchema.parse({ transcript_path: null }))
      .toMatchObject({ transcript_path: null });
  });
});
