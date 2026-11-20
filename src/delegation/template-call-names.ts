/**
 * Former template call names → current role-based names.
 * Old names stay accepted as aliases (invoke / lookup resolve them here); the
 * stored rows are renamed by migration 149 and by the seed. Run records keep the
 * name they were started with. Every entry points at the final name directly so
 * a lookup never needs more than one hop.
 * @implements CC-DELEGATION-PROFILE-DEFAULTS DP-02
 * @implements CC-MODEL-ROLE-MAP MRM-TPL-06
 */
export const TEMPLATE_CALL_NAME_RENAMES = [
  ["sol-mid", "sol"],
  ["sonnet-mid", "sonnet"],
  ["opus-5-5-movable", "opus"],
  ["fable-5-1-movable", "fable"],
  // 2026-11-20: names carrying a model version or a retired role (neco).
  ["opus-5-5", "opus"],
  ["sonnet-5-5", "sonnet"],
  ["fable-5-1", "fable"],
  ["sol-6-1", "sol"],
  ["terra-xhigh", "luna-xhigh"],
  ["claude-sonnet-5-ask", "sonnet-ask"],
  ["claude-sonnet-5-walk", "sonnet-walk"],
  ["design-hard-fable5", "design-hard-fable"],
] as const;

export function canonicalTemplateCallName(name: string): string {
  return TEMPLATE_CALL_NAME_RENAMES.find(([previous]) => previous === name)?.[1] ?? name;
}
