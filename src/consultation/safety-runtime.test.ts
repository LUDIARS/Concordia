import { expect, it, vi } from "vitest";
import { createConsultationSafety } from "./safety-runtime.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { makeTestDb } from '../../tests/helpers/db.js';
import type { HarnessAuditRow } from "../db/harness-audit-repo.js";

it("records unavailable department ownership without persisting request content", async () => {
  const record = vi.fn(() => ({ id: "audit" }) as HarnessAuditRow);
  const sessions = new SessionsRepo(makeTestDb());
  sessions.insertSession({ id: 's', provider: 'claude-code', repo_path: 'E:/fixture/consult',
    repo_origin: null, branch: null, host: 'fixture', started_at: 1, last_seen_at: 1,
    transcript_path: null, metadata: null, department_id: 'missing' });
  const service = createConsultationSafety({
    sessions,
    departments: { find: () => null }, audit: { record }, roots: () => [],
  });
  expect(await service.check({ sessionId: "s", phase: "prompt", text: "private-content" }))
    .toEqual({ blocked: true, reason: "guard_unavailable", penaltyEligible: false });
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ rule: "consultation-guard_unavailable",
    detail: expect.objectContaining({ penalty_status: "not_applicable", notification: "pending" }) }));
  expect(JSON.stringify(record.mock.calls)).not.toContain("private-content");
});
