/** Parse a comma/whitespace separated platform user allowlist. Empty means deny all. */
export function parseReactionUserAllowlist(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function isReactionUserAllowed(raw: string | undefined, userId: string): boolean {
  const id = userId.trim();
  return id.length > 0 && parseReactionUserAllowlist(raw).has(id);
}
