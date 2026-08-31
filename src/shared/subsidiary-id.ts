export const MAX_SUBSIDIARY_ID_LENGTH = 120;

/** Normalize subsidiary IDs at API and metadata boundaries. */
export function normalizeSubsidiaryId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_SUBSIDIARY_ID_LENGTH ? normalized : null;
}

/** Read metadata.subsidiary_id from a session metadata JSON string. */
export function readSubsidiaryId(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const o = JSON.parse(metadata) as unknown;
    if (o && typeof o === "object" && typeof (o as { subsidiary_id?: unknown }).subsidiary_id === "string") {
      return normalizeSubsidiaryId((o as { subsidiary_id: string }).subsidiary_id);
    }
  } catch {
    // Broken metadata is treated as untagged.
  }
  return null;
}
