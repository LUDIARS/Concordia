import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../db/schema.js";
import { DirectorRepo } from "./repo.js";
import { DirectorService, DirectorTransitionError } from "./service.js";
describe("director plan gate", () => {
  it("rejects plans without non-empty acceptance criteria", () => {
    const { db, service, caseId, stepId } = setupPlanCase();

    expect(() => service.submitPlan({
      case_id: caseId,
      step_id: stepId,
      markdown: "# plan",
    })).toThrow(DirectorTransitionError);
    expect(() => service.submitPlan({
      case_id: caseId,
      step_id: stepId,
      markdown: "# plan\n## 受け入れ条件\n\n## 実装\n- work",
    })).toThrow(DirectorTransitionError);
    db.close();
  });

  it("extracts acceptance criteria and versions each submitted plan", () => {
    const { db, service, caseId, stepId } = setupPlanCase();
    const first = service.submitPlan({
      case_id: caseId,
      step_id: stepId,
      markdown: "# plan\n## 受け入れ条件\n- first criterion\n### Notes\n- retained",
    });

    expect(first.decision.plan_version).toBe(1);
    expect(first.decision.impact).toBe("- first criterion\n### Notes\n- retained");

    const second = service.submitPlan({
      case_id: caseId,
      step_id: stepId,
      markdown: "# plan\n## 受け入れ条件\n- revised criterion\n## 実装\n- must not be acceptance",
    });

    expect(second.decision.plan_version).toBe(2);
    expect(second.decision.impact).toBe("- revised criterion");
    expect(service.decidePlan({
      case_id: caseId,
      step_id: stepId,
      action: "approve",
      version: 2,
    }).status).toBe("completed");
    expect(() => service.submitPlan({
      case_id: caseId,
      step_id: stepId,
      markdown: "# plan\n## 受け入れ条件\n- too late",
    })).toThrow("plan step is closed");
    db.close();
  });

  it("rejects stale plan actions and keeps revision requests blocked", () => {
    const onPlanApproved = vi.fn();
    const onPlanRevisionRequested = vi.fn();
    const { db, service, caseId, stepId } = setupPlanCase({
      onPlanApproved,
      onPlanRevisionRequested,
    });
    service.submitPlan({
      case_id: caseId,
      step_id: stepId,
      markdown: "# plan\n## 受け入れ条件\n- v1",
    });
    service.submitPlan({
      case_id: caseId,
      step_id: stepId,
      markdown: "# plan\n## 受け入れ条件\n- v2",
    });

    expect(() => service.decidePlan({
      case_id: caseId,
      step_id: stepId,
      action: "approve",
      version: 1,
    })).toThrow("plan version superseded");
    expect(onPlanApproved).not.toHaveBeenCalled();

    const revised = service.decidePlan({
      case_id: caseId,
      step_id: stepId,
      action: "revise",
      version: 2,
      instruction: "Add rollback criteria",
    });
    expect(revised.status).toBe("blocked");
    expect(revised.handoff_note).toBe("Add rollback criteria");
    expect(onPlanRevisionRequested).toHaveBeenCalledWith(
      expect.objectContaining({ id: caseId }),
      expect.objectContaining({ id: stepId, status: "blocked" }),
      expect.objectContaining({ plan_version: 2 }),
      "Add rollback criteria",
    );
    db.close();
  });
});

function setupPlanCase(callbacks: Pick<
  ConstructorParameters<typeof DirectorService>[0],
  "onPlanApproved" | "onPlanRevisionRequested" | "onPlanDiscarded"
> = {}): {
  db: Database.Database;
  service: DirectorService;
  caseId: string;
  stepId: string;
} {
  const db = new Database(":memory:");
  applyMigrations(db);
  const service = new DirectorService({
    repo: new DirectorRepo(db),
    genius: { query: async () => [] },
    scoreMin: 0.8,
    now: () => 1,
    ...callbacks,
  });
  const created = service.createCase({
    title: "plan gate",
    goal: "require an approved plan",
    project: "Cc",
    steps: [{ kind: "plan", title: "plan" }],
  });
  return {
    db,
    service,
    caseId: created.case.id,
    stepId: created.steps[0].id,
  };
}
