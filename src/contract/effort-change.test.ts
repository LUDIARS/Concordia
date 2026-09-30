import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { buildEffortChangeNotice, changeSessionEffort, effortProviderOf } from "./effort-change.js";
import { parseContractMetadata } from "./schema.js";
import { seedSessionContract } from "./seed-rules.js";
import { saveContract } from "./store.js";
import type { SessionRow } from "../shared/types.js";

let sessions: SessionsRepo;
let apply: ReturnType<typeof vi.fn>;
let notify: ReturnType<typeof vi.fn>;

function insert(id: string, provider: string, metadata: Record<string, unknown>): void {
  const row = {
    id, provider, repo_path: "E:/repo", repo_origin: "LUDIARS/Concordia", branch: "feat/x",
    host: "test", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: JSON.stringify(metadata),
  } as SessionRow;
  sessions.insertSession({ ...row, active_repos: [] });
  saveContract(sessions, id, seedSessionContract(row, "work", "discord:1"), "seed");
}

beforeEach(() => {
  sessions = new SessionsRepo(makeTestDb());
  apply = vi.fn().mockResolvedValue({ ok: true, message: "ok" });
  notify = vi.fn();
});

describe("changeSessionEffort", () => {
  it("applies the new effort, records the human decision and notifies the thread", async () => {
    insert("s1", "claude-code", { model: "claude-opus-5-5", effort: "medium" });
    const result = await changeSessionEffort({ sessions, apply, notify }, {
      sessionId: "s1", effort: "XHIGH", actor: "human", reason: "設計判断が続く", requestedBy: "neco",
    });
    expect(result).toEqual({ ok: true, changed: true, effort: "xhigh", previous: "medium", model: "claude-opus-5-5" });
    expect(apply).toHaveBeenCalledWith({ sessionId: "s1", model: "claude-opus-5-5", effort: "xhigh" });
    const contract = parseContractMetadata(sessions.findSession("s1")!.metadata);
    expect(contract?.effort).toMatchObject({ value: "xhigh", decided_by: "human" });
    expect(notify).toHaveBeenCalledWith({ sessionId: "s1", text: expect.stringContaining("medium → xhigh") });
    expect(notify.mock.calls[0]![0].text).toContain("人間 (neco)");
  });

  it("records a session's own change as an llm decision", async () => {
    insert("s1", "claude-code", { model: "claude-fable-5-1", effort: "medium" });
    await changeSessionEffort({ sessions, apply, notify }, { sessionId: "s1", effort: "low", actor: "session", reason: "定型の修正" });
    expect(parseContractMetadata(sessions.findSession("s1")!.metadata)?.effort).toMatchObject({ value: "low", decided_by: "llm" });
    expect(notify.mock.calls[0]![0].text).toContain("セッション自身");
  });

  it("does nothing when the effort is unchanged", async () => {
    insert("s1", "claude-code", { model: "claude-opus-5-5", effort: "medium" });
    const result = await changeSessionEffort({ sessions, apply, notify }, { sessionId: "s1", effort: "medium", actor: "human", reason: "x" });
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(apply).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps the contract and stays silent when the runtime refuses the change", async () => {
    insert("s1", "claude-code", { model: "claude-opus-5-5", effort: "medium" });
    apply.mockResolvedValueOnce({ ok: false, message: "lictor down" });
    const result = await changeSessionEffort({ sessions, apply, notify }, { sessionId: "s1", effort: "high", actor: "human", reason: "x" });
    expect(result).toMatchObject({ ok: false, status: 502, error: "runtime_apply_failed", message: "lictor down" });
    expect(parseContractMetadata(sessions.findSession("s1")!.metadata)?.effort?.value).not.toBe("high");
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "high", "claude-code", 404, "session_not_found"],
    ["s1", "ultra", "claude-code", 400, "invalid_effort"],
    ["s1", "max", "codex-cli", 400, "invalid_effort"],
    ["s1", "high", "gemma4-12", 400, "effort_not_supported_for_provider"],
  ])("rejects invalid requests (%s %s %s)", async (sessionId, effort, provider, status, error) => {
    insert("s1", provider, { model: "m", effort: "medium" });
    const result = await changeSessionEffort({ sessions, apply, notify }, { sessionId, effort, actor: "human", reason: "x" });
    expect(result).toMatchObject({ ok: false, status, error });
  });

  it("requires a known model because the runtime switch sets both values", async () => {
    const row = {
      id: "s2", provider: "claude-code", repo_path: "E:/repo", repo_origin: null, branch: null,
      host: "test", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null,
    } as SessionRow;
    sessions.insertSession({ ...row, active_repos: [] });
    const result = await changeSessionEffort({ sessions, apply, notify }, { sessionId: "s2", effort: "high", actor: "human", reason: "x" });
    expect(result).toMatchObject({ ok: false, status: 409, error: "model_unknown" });
  });
});

describe("helpers", () => {
  it("maps runtime providers to effort vocabularies", () => {
    expect(effortProviderOf("claude-code")).toBe("claude");
    expect(effortProviderOf("codex-cli")).toBe("codex");
    expect(effortProviderOf("gemma4-12")).toBeNull();
  });

  it("mentions the possible cache rebuild in the notice", () => {
    expect(buildEffortChangeNotice({ previous: null, effort: "high", actor: "session", reason: "r" }))
      .toContain("会話キャッシュが作り直され");
  });
});
