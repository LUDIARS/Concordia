/**
 * 部署の作成・更新・廃止・復帰のユースケース。
 *
 * 順序: 入力の業務検証 (設定の形 / 所有会社の存在 / 担当プロジェクトの範囲 / slug の一意性 /
 * ユースケースの参照先) → 永続化 → 既定部署の切り替え → 変更イベント。 所有会社は作成時に
 * 固定し、 更新では受け付けない (CC-DEPT-INV-01)。 部署行を書くのはこのサービスだけ。
 *
 * @implements spec/feature/departments.md §2 / §3 / §7 / §9
 * @implements SPEC-DEPT-API
 */

import type { DepartmentCreateInput, DepartmentPatchInput, DepartmentRow } from "../db/departments-repo.js";
import { checkDepartmentProjects } from "./project-scope.js";
import { DepartmentSettingsSchema, type DepartmentSettings, type DepartmentSettingsInput } from "./settings.js";

/** 部署の状態所有者が要求する保存操作。 実装は DepartmentsRepo (SQLite)。 */
export interface DepartmentStorePort {
  find(id: string): DepartmentRow | null;
  findBySlug(subsidiaryId: string | null, slug: string): DepartmentRow | null;
  create(input: DepartmentCreateInput, now: number): DepartmentRow;
  patch(id: string, input: DepartmentPatchInput, now: number): DepartmentRow | null;
  setArchived(id: string, archived: boolean, now: number): DepartmentRow | null;
  setDefault(id: string, isDefault: boolean, now: number): DepartmentRow | null;
}

export interface DepartmentOrganizationPort {
  /** 子会社が存在するか。 */
  exists(subsidiaryId: string): boolean;
  /** 子会社の関係プロジェクト。 */
  projects(subsidiaryId: string): string[];
}

/** 部署が参照できるユースケースか (存在して廃止されていない)。 */
export interface DepartmentUseCasePort {
  isAssignable(useCaseId: string): boolean;
}

export interface DepartmentChange {
  department: DepartmentRow;
  action: "created" | "updated" | "archived" | "restored";
  fields: string[];
}

export interface DepartmentServiceDeps {
  repo: DepartmentStorePort;
  organizations: DepartmentOrganizationPort;
  /** 未注入ならユースケースの参照を受け付けない (参照先を確かめられないため)。 */
  useCases?: DepartmentUseCasePort;
  /** 変更の通知先 (イベントバス)。 永続化の後にだけ呼ぶ。 */
  onChange?: (change: DepartmentChange) => void;
  now?: () => number;
}

export interface DepartmentCreateRequest {
  subsidiary_id: string | null;
  name: string;
  slug: string;
  description?: string;
  settings?: DepartmentSettingsInput;
  rules_text?: string;
  sort_order?: number;
  use_case_id?: string | null;
  is_default?: boolean;
}

export type DepartmentUpdateRequest = Omit<Partial<DepartmentCreateRequest>, "subsidiary_id">;

export type DepartmentServiceError =
  | { error: "subsidiary_not_found" }
  | { error: "department_not_found" }
  | { error: "department_slug_taken" }
  | { error: "department_archived" }
  | { error: "invalid_department_settings"; detail: string }
  | { error: "use_case_not_assignable" }
  | { error: "department_projects_outside_subsidiary_scope"; outside: string[] };

export type DepartmentServiceResult = { ok: true; department: DepartmentRow } | ({ ok: false } & DepartmentServiceError);

type Failure = { ok: false } & DepartmentServiceError;

export class DepartmentService {
  private readonly now: () => number;

  constructor(private readonly deps: DepartmentServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  create(request: DepartmentCreateRequest): DepartmentServiceResult {
    const organizationId = request.subsidiary_id ?? null;
    if (organizationId !== null && !this.deps.organizations.exists(organizationId)) {
      return { ok: false, error: "subsidiary_not_found" };
    }
    const settings = this.parseSettings(request.settings ?? {});
    if ("error" in settings) return settings;
    const scope = this.checkProjects(organizationId, settings.projects);
    if (scope) return scope;
    const useCase = this.checkUseCase(request.use_case_id);
    if (useCase) return useCase;
    if (this.deps.repo.findBySlug(organizationId, request.slug)) {
      return { ok: false, error: "department_slug_taken" };
    }
    const now = this.now();
    let department = this.deps.repo.create({
      subsidiary_id: organizationId,
      name: request.name,
      slug: request.slug,
      description: request.description,
      settings,
      rules_text: request.rules_text,
      sort_order: request.sort_order,
      use_case_id: request.use_case_id ?? null,
    }, now);
    if (request.is_default) department = this.deps.repo.setDefault(department.id, true, now) ?? department;
    this.deps.onChange?.({ department, action: "created", fields: Object.keys(request) });
    return { ok: true, department };
  }

  update(id: string, request: DepartmentUpdateRequest): DepartmentServiceResult {
    const current = this.deps.repo.find(id);
    if (!current) return { ok: false, error: "department_not_found" };
    let settings: DepartmentSettings | undefined;
    if (request.settings !== undefined) {
      const parsed = this.parseSettings(request.settings);
      if ("error" in parsed) return parsed;
      const scope = this.checkProjects(current.subsidiary_id, parsed.projects);
      if (scope) return scope;
      settings = parsed;
    }
    const useCase = this.checkUseCase(request.use_case_id);
    if (useCase) return useCase;
    if (request.slug && request.slug !== current.slug) {
      const holder = this.deps.repo.findBySlug(current.subsidiary_id, request.slug);
      if (holder && holder.id !== id) return { ok: false, error: "department_slug_taken" };
    }
    // 廃止した部署を既定にすると、 部署未指定の起動が全部「廃止済み」で止まる。
    if (request.is_default && current.archived_at !== null) return { ok: false, error: "department_archived" };
    const now = this.now();
    const { is_default: isDefault, settings: _settings, ...fields } = request;
    let department = this.deps.repo.patch(id, { ...fields, ...(settings ? { settings } : {}) }, now);
    if (!department) return { ok: false, error: "department_not_found" };
    if (isDefault !== undefined) department = this.deps.repo.setDefault(id, isDefault, now) ?? department;
    this.deps.onChange?.({ department, action: "updated", fields: Object.keys(request) });
    return { ok: true, department };
  }

  /** 廃止 / 復帰。 同じ状態への要求は変更なしで成功する (冪等)。 廃止は既定からも外す。 */
  setArchived(id: string, archived: boolean): DepartmentServiceResult {
    const current = this.deps.repo.find(id);
    if (!current) return { ok: false, error: "department_not_found" };
    const changed = (current.archived_at !== null) !== archived;
    const department = this.deps.repo.setArchived(id, archived, this.now());
    if (!department) return { ok: false, error: "department_not_found" };
    if (changed) {
      this.deps.onChange?.({ department, action: archived ? "archived" : "restored", fields: ["archived_at"] });
    }
    return { ok: true, department };
  }

  private parseSettings(input: DepartmentSettingsInput): DepartmentSettings | Failure {
    const parsed = DepartmentSettingsSchema.safeParse(input);
    if (parsed.success) return parsed.data;
    return { ok: false, error: "invalid_department_settings", detail: parsed.error.issues.map((issue) => issue.message).join("; ") };
  }

  private checkUseCase(useCaseId: string | null | undefined): Failure | null {
    if (!useCaseId) return null;
    if (this.deps.useCases?.isAssignable(useCaseId) === true) return null;
    return { ok: false, error: "use_case_not_assignable" };
  }

  private checkProjects(organizationId: string | null, projects: readonly string[]): Failure | null {
    const organizationProjects = organizationId === null ? null : this.deps.organizations.projects(organizationId);
    const scope = checkDepartmentProjects(projects, organizationProjects);
    if (scope.ok) return null;
    return { ok: false, error: scope.denial, outside: scope.outside };
  }
}
