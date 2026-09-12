// @spec セッションの設計・開始確認・実装・調整
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { SessionsRepo } from "../../db/sessions-repo.js";
import { registerWorkPhaseRoutes } from "./work-phase.js";
import { PatchSchema, StartSchema } from "./shared.js";
import { updateSessionWorkPhase } from "../../work/update-session-work-phase.js";
import { WORK_PHASE_KEY } from "../../work/session-work-phase.js";

describe("work phase reporting API", () => {
  let repo: SessionsRepo;
  let app: Hono;
  const session = { id: "phase-test", provider: "codex-cli" as const, repo_path: "/repo", branch: "feature", repo_origin: null,
    host: "test", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: JSON.stringify({ unrelated: "keep" }) };
  const confirmation = { expected_revision: 0, phase: "confirmation" as const, design_summary: "確定した設計", reason: "開始確認" };
  const put = (body: unknown) => app.request("/phase-test/work-phase", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  beforeEach(() => {
    repo = new SessionsRepo(makeTestDb());
    repo.insertSession(session);
    app = new Hono();
    registerWorkPhaseRoutes(app, { repo });
  });

  it("preserves other metadata and rejects stale reports without appending an event", async () => {
    expect((await put(confirmation)).status).toBe(200);
    expect((await put({ ...confirmation, phase: "design" })).status).toBe(409);
    const read = await (await app.request("/phase-test/work-phase")).json();
    expect(read.work_phase).toMatchObject({ phase: "confirmation", revision: 1, approval_reference: null });
    expect(JSON.parse(repo.findSession(session.id)!.metadata!).unrelated).toBe("keep");
    expect(repo.recentEvents(session.id, 10)).toHaveLength(1);
  });

  it("rejects implementation without a human instruction reference", async () => {
    const denied = await put({ ...confirmation, phase: "implementation" });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({ error: "human_start_confirmation_required" });
    expect(repo.recentEvents(session.id, 10)).toHaveLength(0);
    expect((await put({ ...confirmation, phase: "implementation", approval_reference: "人間の開始指示" })).status).toBe(200);
  });

  it("requires reassessment when the registered task changes", async () => {
    await put({ ...confirmation, phase: "implementation", approval_reference: "元の範囲の開始指示" });
    repo.patchSession(session.id, { current_task: "別の作業" });
    const read = await (await app.request("/phase-test/work-phase")).json();
    expect(read.work_phase).toMatchObject({ phase: "unknown", revision: 1, approval_reference: null });
    expect((await put({ ...confirmation, expected_revision: 1, phase: "implementation" })).status).toBe(400);
  });

  it("rolls back the audit event if state persistence fails", () => {
    const fail = vi.spyOn(repo, "setMetadata").mockImplementationOnce(() => { throw new Error("write failed"); });
    try {
      expect(() => updateSessionWorkPhase(repo, session.id, confirmation, 123)).toThrow("write failed");
    } finally { fail.mockRestore(); }
    expect(repo.recentEvents(session.id, 10)).toHaveLength(0);
    expect(repo.findSession(session.id)?.metadata).toBe(session.metadata);
  });

  it("does not expose the dedicated state through generic metadata writes", () => {
    const metadata = { [WORK_PHASE_KEY]: { phase: "implementation" } };
    expect(PatchSchema.safeParse({ metadata }).success).toBe(false);
    expect(StartSchema.safeParse({ ...session, metadata }).success).toBe(false);
    expect(PatchSchema.safeParse({ metadata: { lictor_port: 12345 } }).success).toBe(true);
  });

  it("rejects invalid reports, missing sessions, and reports after session end", async () => {
    expect((await put({ ...confirmation, phase: "approved" })).status).toBe(400);
    expect((await put({ ...confirmation, approval: true })).status).toBe(400);
    expect((await app.request("/missing/work-phase")).status).toBe(404);
    repo.setStatus(session.id, "ended", 2, 2);
    expect((await put(confirmation)).status).toBe(400);
  });
});
