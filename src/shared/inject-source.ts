export type InjectSourcePlatform = "discord" | "slack";

export interface ParsedInjectSource {
  raw: string;
  platform: InjectSourcePlatform | null;
  userId: string | null;
}

const SOURCE_RE = /^(discord|slack):([^:]+)/;

export function parseInjectSource(source: unknown): ParsedInjectSource {
  const raw = typeof source === "string" ? source : "";
  const match = SOURCE_RE.exec(raw);
  const userId = match?.[2]?.trim() ?? "";
  if (!match || !userId) return { raw, platform: null, userId: null };
  return { raw, platform: match[1] as InjectSourcePlatform, userId };
}
