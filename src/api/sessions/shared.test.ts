import { describe, expect, it } from "vitest";
import type { SessionRow } from "../../shared/types.js";
import { PatchSchema, serializeSession, StartSchema, toSpawnProvider } from "./shared.js";

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

describe("antigravity-cli (Lictor の agy provider)", () => {
  it("session 登録で受理し、 spawn 時は lictor agy に写す", () => {
    expect(toSpawnProvider("antigravity-cli")).toBe("agy");
    expect(toSpawnProvider("gemini-cli")).toBe("gemini");
    const parsed = StartSchema.safeParse({
      id: "lictor-agy-1", provider: "antigravity-cli", repo_path: "E:/Document/Ars/Concordia", host: "host",
    });
    expect(parsed.success).toBe(true);
  });
});

it("accepts Grok CLI registration and resolves spawn to lictor grok", () => {
  expect(StartSchema.safeParse({ id: "lictor-grok-1", provider: "grok-cli", repo_path: "E:/fixture", host: "host" }).success)
    .toBe(true);
  expect(toSpawnProvider("grok-cli")).toBe("grok");
});

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
