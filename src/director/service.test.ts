import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../db/schema.js";
import type { GeniusCard, GeniusClient } from "../inquiry/genius-client.js";
import { DirectorRepo } from "./repo.js";
import { DirectorService, DirectorTransitionError } from "./service.js";

describe("DirectorService", () => {
  it("keeps task, delegation, PR, and confirm references on ordered workflow steps", () => {
    const service = makeService([]);
    const created = service.createCase({
      title: "原稿フロー", goal: "判断と実装を分離する", project: "Cc",
      steps: [{
        kind: "delegate", title: "実装を委託する", task_path: "spec/tasks/work.md",
        delegation_run_id: "run-1", local_pr_id: "lpr-2", confirm_run_id: "confirm-3",
      }],
    });

    expect(created.steps).toEqual([expect.objectContaining({
      sequence: 1, kind: "delegate", task_path: "spec/tasks/work.md", delegation_run_id: "run-1",
      local_pr_id: "lpr-2", confirm_run_id: "confirm-3", status: "pending",
    })]);
  });

  it("uses the highest qualifying Genius judgment verbatim instead of inventing a Director decision", async () => {
    const service = makeService([card({ score: 0.91, judgment: "レビュー完了後に確認工程へ進める。" })]);
    const created = service.createCase({
      title: "原稿フロー", goal: "判断を委譲する", project: "Cc",
      steps: [{ kind: "review", title: "レビュー" }],
    });
    const step = service.updateStep({ case_id: created.case.id, step_id: created.steps[0].id, status: "active" });
    const result = await service.requestDecision(decisionRequest(created.case.id, step.id));

    expect(result.decision).toMatchObject({
      decision: "proceed", genius_available: true, instruction: "レビュー完了後に確認工程へ進める。",
    });
    expect(result.decision.genius_cards).toHaveLength(1);
  });

  it("records Genius unavailability as self_judge without treating Cc as a decision source", async () => {
    const service = makeService(null);
    const created = service.createCase({
      title: "原稿フロー", goal: "停止しない", project: "Cc", steps: [{ kind: "implement", title: "実装" }],
    });
    const result = await service.requestDecision(decisionRequest(created.case.id, created.steps[0].id));

    expect(result.decision).toMatchObject({ decision: "self_judge", genius_available: false });
    expect(result.decision.instruction).toContain("Genius");
  });

  it("does not proceed from a qualifying card that contains no judgment", async () => {
    const service = makeService([card({ judgment: undefined })]);
    const created = service.createCase({
      title: "原稿フロー",
      goal: "Cc が判断内容を補完しない",
      project: "Cc",
      steps: [{ kind: "implement", title: "実装" }],
    });

    const result = await service.requestDecision(
      decisionRequest(created.case.id, created.steps[0].id),
    );

    expect(result.decision.decision).toBe("self_judge");
    expect(result.decision.instruction).toContain("通常判断");
  });

  it.each(["authority", "scope"] as const)(
    "blocks %s decisions when Genius is unavailable",
    async (kind) => {
      const service = makeService(null);
      const created = service.createCase({
        title: "原稿フロー",
        goal: "権限境界を守る",
        project: "Cc",
        steps: [{ kind: "implement", title: "実装" }],
      });
      const result = await service.requestDecision({
        ...decisionRequest(created.case.id, created.steps[0].id),
        kind,
      });

      expect(result.decision).toMatchObject({
        decision: "ask_human",
        genius_available: false,
      });
      expect(result.decision.instruction).toContain("人間");
      expect(result.step.status).toBe("blocked");
    },
  );

  it("blocks authority decisions when Genius has no qualifying precedent", async () => {
    const service = makeService([]);
    const created = service.createCase({
      title: "原稿フロー",
      goal: "前例不足を人間へ上げる",
      project: "Cc",
      steps: [{ kind: "implement", title: "実装" }],
    });
    const result = await service.requestDecision({
      ...decisionRequest(created.case.id, created.steps[0].id),
      kind: "authority",
    });

    expect(result.decision).toMatchObject({ decision: "ask_human", genius_available: true });
    expect(result.decision.instruction).toContain("十分な前例");
    expect(result.step.status).toBe("blocked");
  });

  it("blocks an active step when Genius identifies a human-approval decision", async () => {
    const service = makeService([card({ domain: "権限判断", tags: ["人間承認"] })]);
    const created = service.createCase({
      title: "原稿フロー", goal: "権限を分離する", project: "Cc", steps: [{ kind: "delegate", title: "委託" }],
    });
    service.updateStep({ case_id: created.case.id, step_id: created.steps[0].id, status: "active" });
    const result = await service.requestDecision({ ...decisionRequest(created.case.id, created.steps[0].id), kind: "authority" });

    expect(result.decision.decision).toBe("ask_human");
    expect(result.step.status).toBe("blocked");
  });

  it("does not reopen a completed step", () => {
    const service = makeService([]);
    const created = service.createCase({
      title: "原稿フロー", goal: "工程を守る", project: "Cc", steps: [{ kind: "complete", title: "完了" }],
    });
    service.updateStep({ case_id: created.case.id, step_id: created.steps[0].id, status: "active" });
    service.updateStep({ case_id: created.case.id, step_id: created.steps[0].id, status: "completed" });

    expect(() => service.updateStep({
      case_id: created.case.id, step_id: created.steps[0].id, status: "active",
    })).toThrow(DirectorTransitionError);
  });

  it("does not reopen a step completed while waiting for Genius", async () => {
    let service: DirectorService;
    let caseId = "";
    let stepId = "";
    const genius: GeniusClient = {
      query: async () => {
        service.updateStep({ case_id: caseId, step_id: stepId, status: "completed" });
        return [card({ domain: "権限判断", tags: ["人間承認"] })];
      },
    };
    service = makeServiceWithGenius(genius);
    const created = service.createCase({
      title: "原稿フロー",
      goal: "競合時も terminal を守る",
      project: "Cc",
      steps: [{ kind: "review", title: "レビュー" }],
    });
    caseId = created.case.id;
    stepId = created.steps[0].id;
    service.updateStep({ case_id: caseId, step_id: stepId, status: "active" });

    const result = await service.requestDecision({
      ...decisionRequest(caseId, stepId),
      kind: "authority",
    });

    expect(result.decision.decision).toBe("ask_human");
    expect(result.step.status).toBe("completed");
    expect(service.getCase(caseId)?.decisions).toHaveLength(1);
  });

  it("returns decisions in insertion order when timestamps collide", async () => {
    const service = makeService([]);
    const created = service.createCase({
      title: "原稿フロー",
      goal: "監査順序を固定する",
      project: "Cc",
      steps: [{ kind: "review", title: "レビュー" }],
    });
    await service.requestDecision({
      ...decisionRequest(created.case.id, created.steps[0].id),
      question: "first",
    });
    await service.requestDecision({
      ...decisionRequest(created.case.id, created.steps[0].id),
      question: "second",
    });

    expect(service.getCase(created.case.id)?.decisions.map((decision) => decision.question))
      .toEqual(["first", "second"]);
  });
});

function makeService(cards: GeniusCard[] | null): DirectorService {
  return makeServiceWithGenius({ query: async () => cards });
}

function makeServiceWithGenius(genius: GeniusClient): DirectorService {
  const db = new Database(":memory:");
  applyMigrations(db);
  return new DirectorService({ repo: new DirectorRepo(db), genius, scoreMin: 0.8, now: () => 1_730_000_000_000 });
}

function card(overrides: Partial<GeniusCard> = {}): GeniusCard {
  return { id: "genius-1", title: "前例", score: 0.9, domain: "設計判断", ...overrides };
}

function decisionRequest(caseId: string, stepId: string) {
  return {
    case_id: caseId,
    step_id: stepId,
    kind: "design" as const,
    question: "確認へ進めるか",
    facts: ["レビューは完了した"],
    options: ["確認へ進む", "実装へ戻る"],
    impact: "次の委託の開始時期に影響する",
  };
}
