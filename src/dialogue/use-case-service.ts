/**
 * ユースケースの作成・更新・廃止・削除のユースケース (application)。
 *
 * 作成はフォーマットの初期値に入力を重ねる。 部署が参照中のユースケースは削除できず、
 * 廃止だけができる (CC-DLG-INV-06)。
 *
 * @implements spec/feature/dialogue-context.md §2 / §3
 * @implements SPEC-DLG-USE-CASES
 */

import type { UseCaseRow, UseCaseWriteInput } from "../db/use-cases-repo.js";
import { USE_CASE_FORMATS, type UseCaseFormatKey, type UseCaseWorkMode } from "./formats.js";

export interface UseCaseStorePort {
  find(id: string): UseCaseRow | null;
  findBySlug(slug: string): UseCaseRow | null;
  create(input: UseCaseWriteInput, now: number): UseCaseRow;
  patch(id: string, input: Partial<UseCaseWriteInput>, now: number): UseCaseRow | null;
  setArchived(id: string, archived: boolean, now: number): UseCaseRow | null;
  countDepartmentReferences(id: string): number;
  delete(id: string): boolean;
}

export interface UseCaseCreateRequest {
  name: string;
  slug: string;
  format: UseCaseFormatKey;
  summary?: string;
  work_mode?: UseCaseWorkMode;
  pre_data?: string;
  use_requester_profile?: boolean;
}

export type UseCaseServiceError =
  | "use_case_not_found"
  | "use_case_slug_taken"
  | "use_case_in_use";

export type UseCaseServiceResult =
  | { ok: true; useCase: UseCaseRow }
  | { ok: false; error: UseCaseServiceError; references?: number };

export class UseCaseService {
  private readonly now: () => number;

  constructor(private readonly deps: { repo: UseCaseStorePort; now?: () => number }) {
    this.now = deps.now ?? Date.now;
  }

  create(request: UseCaseCreateRequest): UseCaseServiceResult {
    if (this.deps.repo.findBySlug(request.slug)) return { ok: false, error: "use_case_slug_taken" };
    const format = USE_CASE_FORMATS[request.format];
    const useCase = this.deps.repo.create({
      name: request.name,
      slug: request.slug,
      format: request.format,
      summary: request.summary ?? format.summary,
      work_mode: request.work_mode ?? format.workMode,
      pre_data: request.pre_data ?? format.preData,
      use_requester_profile: request.use_requester_profile ?? format.useRequesterProfile,
    }, this.now());
    return { ok: true, useCase };
  }

  update(id: string, input: Partial<UseCaseWriteInput>): UseCaseServiceResult {
    if (!this.deps.repo.find(id)) return { ok: false, error: "use_case_not_found" };
    if (input.slug) {
      const holder = this.deps.repo.findBySlug(input.slug);
      if (holder && holder.id !== id) return { ok: false, error: "use_case_slug_taken" };
    }
    const useCase = this.deps.repo.patch(id, input, this.now());
    return useCase ? { ok: true, useCase } : { ok: false, error: "use_case_not_found" };
  }

  setArchived(id: string, archived: boolean): UseCaseServiceResult {
    const useCase = this.deps.repo.setArchived(id, archived, this.now());
    return useCase ? { ok: true, useCase } : { ok: false, error: "use_case_not_found" };
  }

  /** 部署が参照していないユースケースだけを削除する。 */
  delete(id: string): { ok: true } | { ok: false; error: UseCaseServiceError; references?: number } {
    if (!this.deps.repo.find(id)) return { ok: false, error: "use_case_not_found" };
    const references = this.deps.repo.countDepartmentReferences(id);
    if (references > 0) return { ok: false, error: "use_case_in_use", references };
    this.deps.repo.delete(id);
    return { ok: true };
  }
}
