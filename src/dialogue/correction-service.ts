/**
 * 人の訂正を登録するユースケース (application)。
 *
 * セッションからの登録 (Discord `/co-correct`) は、 セッションの部署 → ユースケースを
 * 引き、 会社・部署・セッション・登録者を添えて保存する (CC-DLG-INV-01 / 05)。
 * 訂正先が無いセッションを黙って別のユースケースへ振らない。
 *
 * @implements spec/feature/dialogue-context.md §6
 * @implements SPEC-DLG-CORRECTIONS
 */

import type { CorrectionCreateInput, CorrectionRow, CorrectionSource } from "../db/use-case-corrections-repo.js";

export interface CorrectionLookupPort {
  /** セッションの所属部署 id。 セッションが無ければ undefined、 未配属なら null。 */
  sessionDepartmentId(sessionId: string): string | null | undefined;
  department(id: string): { id: string; subsidiary_id: string | null; use_case_id: string | null } | null;
  useCase(id: string): { id: string; archived_at: number | null } | null;
}

export interface CorrectionStorePort {
  create(input: CorrectionCreateInput, now: number): CorrectionRow;
}

export type CorrectionRegisterError =
  | "session_not_found"
  | "session_has_no_department"
  | "department_has_no_use_case"
  | "use_case_archived";

export type CorrectionRegisterResult =
  | { ok: true; correction: CorrectionRow }
  | { ok: false; error: CorrectionRegisterError };

export function registerSessionCorrection(
  deps: { lookup: CorrectionLookupPort; store: CorrectionStorePort; now?: () => number },
  input: { sessionId: string; question: string; correction: string; author: string; source: CorrectionSource },
): CorrectionRegisterResult {
  const departmentId = deps.lookup.sessionDepartmentId(input.sessionId);
  if (departmentId === undefined) return { ok: false, error: "session_not_found" };
  if (departmentId === null) return { ok: false, error: "session_has_no_department" };
  const department = deps.lookup.department(departmentId);
  if (!department?.use_case_id) return { ok: false, error: "department_has_no_use_case" };
  const useCase = deps.lookup.useCase(department.use_case_id);
  if (!useCase) return { ok: false, error: "department_has_no_use_case" };
  if (useCase.archived_at !== null) return { ok: false, error: "use_case_archived" };
  const correction = deps.store.create({
    use_case_id: useCase.id,
    subsidiary_id: department.subsidiary_id,
    department_id: department.id,
    session_id: input.sessionId,
    source: input.source,
    question: input.question.trim(),
    correction: input.correction.trim(),
    author: input.author.trim(),
  }, (deps.now ?? Date.now)());
  return { ok: true, correction };
}
