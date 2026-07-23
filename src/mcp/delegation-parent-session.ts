/** 明示値を優先し、未指定時だけ wrapped session ID を継承する。 */
export function resolveDelegationParentSessionId(
  explicitParentSessionId: string | null | undefined,
  inheritedSessionId: string | null | undefined,
): string | undefined {
  const explicit = explicitParentSessionId?.trim();
  if (explicit) return explicit;
  return inheritedSessionId?.trim() || undefined;
}
