/** Stable aliases preserve existing callers. @implements CC-DELEGATION-PROFILE-DEFAULTS DP-02 */
export const TEMPLATE_CALL_NAME_RENAMES = [
  ["sol-mid", "sol-6-1"],
  ["sonnet-mid", "sonnet-5-5"],
  ["opus-5-5-movable", "opus-5-5"],
  ["fable-5-1-movable", "fable-5-1"],
] as const;

export function canonicalTemplateCallName(name: string): string {
  return TEMPLATE_CALL_NAME_RENAMES.find(([previous]) => previous === name)?.[1] ?? name;
}
