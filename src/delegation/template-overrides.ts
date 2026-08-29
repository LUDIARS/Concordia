import type { DelegationTemplateOverrideRow, DelegationTemplateRow } from "../db/delegation-repo.js";

export const TEMPLATE_OVERRIDE_PATCH_KEYS = ["target_provider", "model", "default_cwd", "runtime_options_json", "is_active"] as const;
type PatchKey = (typeof TEMPLATE_OVERRIDE_PATCH_KEYS)[number];
type TemplatePatch = Partial<Pick<DelegationTemplateRow, PatchKey>>;

/** @implements SPEC-DELEGATION-TEMPLATE-OVERRIDES */
export function resolveTemplateForScope(
  base: DelegationTemplateRow,
  overrides: readonly DelegationTemplateOverrideRow[],
  scope: { platform: NodeJS.Platform | null; siteId: string | null },
): DelegationTemplateRow {
  let resolved = { ...base };
  const candidates = [
    ...(scope.platform ? overrides.filter((row) => row.is_active === 1 && row.scope_kind === "platform" && row.scope_key === scope.platform) : []),
    ...(scope.siteId ? overrides.filter((row) => row.is_active === 1 && row.scope_kind === "site" && row.scope_key === scope.siteId) : []),
  ];
  for (const row of candidates) resolved = applyTemplatePatch(resolved, parsePatch(row.patch_json));
  return resolved;
}

/** @implements SPEC-DELEGATION-TEMPLATE-OVERRIDES */
function parsePatch(raw: string): TemplatePatch {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("invalid_template_override_patch_json"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_template_override_patch_json");
  const patch = parsed as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    if (!(TEMPLATE_OVERRIDE_PATCH_KEYS as readonly string[]).includes(key)) throw new Error(`unknown_template_override_patch_key:${key}`);
  }
  return patch as TemplatePatch;
}

/** @implements SPEC-DELEGATION-TEMPLATE-OVERRIDES */
function applyTemplatePatch(base: DelegationTemplateRow, patch: TemplatePatch): DelegationTemplateRow {
  const next = { ...base, ...patch };
  if (patch.runtime_options_json !== undefined) {
    next.runtime_options_json = JSON.stringify({ ...parseOptions(base.runtime_options_json), ...parseOptions(patch.runtime_options_json) });
  }
  return next;
}

/** @implements SPEC-DELEGATION-TEMPLATE-OVERRIDES */
function parseOptions(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* validated at its owning boundary */ }
  throw new Error("invalid_template_runtime_options_json");
}
