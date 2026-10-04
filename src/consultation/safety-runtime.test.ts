import { expect, it, vi } from "vitest";
import { createConsultationSafety } from "./safety-runtime.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { HarnessAuditRow } from "../db/harness-audit-repo.js";

it("records unavailable department ownership without persisting request content", async () => {
  const record = vi.fn(() => ({ id: "audit" }) as HarnessAuditRow);
  const service = createConsultationSafety({
    sessions: { findSession: () => ({ department_id: "missing" }) } as Pick<SessionsRepo, "findSession">,
    departments: { find: () => null }, audit: { record }, roots: () => [],
  });
  expect(await service.check({ sessionId: "s", phase: "prompt", text: "private-content" }))
    .toEqual({ blocked: true, reason: "guard_unavailable", penaltyEligible: false });
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ rule: "consultation-guard_unavailable",
    detail: expect.objectContaining({ penalty_status: "not_applicable", notification: "pending" }) }));
  expect(JSON.stringify(record.mock.calls)).not.toContain("private-content");
});
