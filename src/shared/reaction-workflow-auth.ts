export type ReactionUserAllowlistInput = string | readonly string[] | undefined;

/** Parse platform user IDs without changing their case. Empty means deny all. */
export function parseReactionUserAllowlist(raw: ReactionUserAllowlistInput): ReadonlySet<string> {
  const serialized = typeof raw === "string" ? raw : (raw ?? []).join("\n");
  return new Set(
    serialized
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function normalizeReactionUserIds(raw: ReactionUserAllowlistInput): string[] {
  return [...parseReactionUserAllowlist(raw)];
}

export function isReactionUserAllowed(raw: ReactionUserAllowlistInput, userId: string): boolean {
  const id = userId.trim();
  return id.length > 0 && parseReactionUserAllowlist(raw).has(id);
}
