export type ReactionUserAllowlistInput = string | readonly string[] | undefined;

/** Sentinel token that opts a platform's allowlist into "allow every user" instead of exact-match IDs. */
export const REACTION_ALLOW_ALL_TOKEN = "*";

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

export function isReactionAllowAll(raw: ReactionUserAllowlistInput): boolean {
  return parseReactionUserAllowlist(raw).has(REACTION_ALLOW_ALL_TOKEN);
}

export function isReactionUserAllowed(raw: ReactionUserAllowlistInput, userId: string): boolean {
  const id = userId.trim();
  if (id.length === 0) return false;
  const allowlist = parseReactionUserAllowlist(raw);
  return allowlist.has(REACTION_ALLOW_ALL_TOKEN) || allowlist.has(id);
}
