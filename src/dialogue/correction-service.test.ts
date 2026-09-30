import { describe, expect, it } from "vitest";
import type { CorrectionCreateInput, CorrectionRow } from "../db/use-case-corrections-repo.js";
import { registerSessionCorrection, type CorrectionLookupPort } from "./correction-service.js";

function lookup(overrides: Partial<CorrectionLookupPort> = {}): CorrectionLookupPort {
  return {
    sessionDepartmentId: () => "dept-qa",
    department: () => ({ id: "dept-qa", subsidiary_id: "glab", use_case_id: "uc-qa" }),
    useCase: () => ({ id: "uc-qa", archived_at: null }),
    ...overrides,
  };
}

function store() {
  const created: CorrectionCreateInput[] = [];
  return {
    created,
    create: (input: CorrectionCreateInput, now: number): CorrectionRow => {
      created.push(input);
      return { ...input, id: "corr-1", active: 1, created_at: now, updated_at: now };
    },
  };
}

const input = { sessionId: "s-1", question: " DDD の利点 ", correction: " 用語を揃えられる ", author: "user-1", source: "discord" as const };

describe("registerSessionCorrection", () => {
  it("stores the correction with the session's company, department and use case (CC-DLG-INV-01/05)", () => {
    const sink = store();
    const result = registerSessionCorrection({ lookup: lookup(), store: sink, now: () => 9 }, input);
    expect(result).toMatchObject({ ok: true, correction: { id: "corr-1", created_at: 9 } });
    expect(sink.created).toEqual([{
      use_case_id: "uc-qa",
      subsidiary_id: "glab",
      department_id: "dept-qa",
      session_id: "s-1",
      source: "discord",
      question: "DDD の利点",
      correction: "用語を揃えられる",
      author: "user-1",
    }]);
  });

  it("explains why a correction has nowhere to go", () => {
    const sink = store();
    expect(registerSessionCorrection({ lookup: lookup({ sessionDepartmentId: () => undefined }), store: sink }, input))
      .toEqual({ ok: false, error: "session_not_found" });
    expect(registerSessionCorrection({ lookup: lookup({ sessionDepartmentId: () => null }), store: sink }, input))
      .toEqual({ ok: false, error: "session_has_no_department" });
    expect(registerSessionCorrection({
      lookup: lookup({ department: () => ({ id: "d", subsidiary_id: null, use_case_id: null }) }),
      store: sink,
    }, input)).toEqual({ ok: false, error: "department_has_no_use_case" });
    expect(registerSessionCorrection({ lookup: lookup({ useCase: () => ({ id: "uc-qa", archived_at: 3 }) }), store: sink }, input))
      .toEqual({ ok: false, error: "use_case_archived" });
    expect(sink.created).toEqual([]);
  });
});
