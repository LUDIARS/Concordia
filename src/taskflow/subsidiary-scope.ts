import { normalizeSubsidiaryId } from "../shared/subsidiary-id.js";

/** @implements spec/feature/subsidiary-delegation.md §5 — Taskflow organization scope. */
export type TaskflowOrganizationScope =
  | { kind: "all" }
  | { kind: "head_office" }
  | { kind: "subsidiary"; subsidiaryId: string };

export type TaskflowScopeParseResult =
  | { ok: true; scope: TaskflowOrganizationScope }
  | { ok: false; error: "invalid_subsidiary_id" | "invalid_head_office" | "conflicting_organization_scope" };

/** Query の未指定は全社。 head_office=1 と subsidiary_id は排他的。 */
export function parseTaskflowOrganizationScope(input: {
  subsidiaryId?: string;
  headOffice?: string;
}): TaskflowScopeParseResult {
  const subsidiaryId = normalizeSubsidiaryId(input.subsidiaryId);
  if (input.subsidiaryId !== undefined && subsidiaryId === null) {
    return { ok: false, error: "invalid_subsidiary_id" };
  }
  if (input.headOffice !== undefined && input.headOffice !== "1") {
    return { ok: false, error: "invalid_head_office" };
  }
  if (subsidiaryId && input.headOffice === "1") {
    return { ok: false, error: "conflicting_organization_scope" };
  }
  if (subsidiaryId) return { ok: true, scope: { kind: "subsidiary", subsidiaryId } };
  if (input.headOffice === "1") return { ok: true, scope: { kind: "head_office" } };
  return { ok: true, scope: { kind: "all" } };
}

export function matchesTaskflowOrganizationScope(
  subsidiaryId: string | null | undefined,
  scope: TaskflowOrganizationScope,
): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "head_office") return !subsidiaryId;
  return subsidiaryId === scope.subsidiaryId;
}

export interface TaskflowSubsidiaryReference {
  kind: "delegation_run" | "source_session";
  id: string;
  found: boolean;
  subsidiaryId: string | null;
}

export type TaskflowSubsidiaryResolution =
  | { ok: true; subsidiaryId?: string | null }
  | { ok: false; error: "invalid_subsidiary_id" | "unknown_delegation_run" | "unknown_source_session" | "conflicting_subsidiary_ownership" };

/**
 * Taskflow state に焼く所有IDを、明示値と run/session の証跡から決める。
 * reference が空なら既存値を維持し、子会社ID同士の不一致は黙って上書きしない。
 */
export function resolveTaskflowSubsidiary(input: {
  explicit: unknown;
  references: readonly TaskflowSubsidiaryReference[];
}): TaskflowSubsidiaryResolution {
  const hasExplicit = input.explicit !== undefined;
  let explicitId: string | null = null;
  if (hasExplicit) {
    if (input.explicit === null) {
      explicitId = null;
    } else {
      const normalized = normalizeSubsidiaryId(input.explicit);
      if (!normalized) return { ok: false, error: "invalid_subsidiary_id" };
      explicitId = normalized;
    }
  }

  for (const reference of input.references) {
    if (reference.found) continue;
    return {
      ok: false,
      error: reference.kind === "delegation_run" ? "unknown_delegation_run" : "unknown_source_session",
    };
  }

  const referencedIds = [...new Set(input.references
    .map((reference) => reference.subsidiaryId)
    .filter((value): value is string => !!value))];
  if (referencedIds.length > 1) return { ok: false, error: "conflicting_subsidiary_ownership" };
  const referencedId = referencedIds[0] ?? null;
  if (hasExplicit && referencedId !== null && explicitId !== referencedId) {
    return { ok: false, error: "conflicting_subsidiary_ownership" };
  }
  if (hasExplicit) return { ok: true, subsidiaryId: explicitId };
  if (input.references.length > 0) return { ok: true, subsidiaryId: referencedId };
  return { ok: true };
}
