/** Read metadata.subsidiary_id from a session metadata JSON string. */
export function readSubsidiaryId(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const o = JSON.parse(metadata) as unknown;
    if (o && typeof o === "object" && typeof (o as { subsidiary_id?: unknown }).subsidiary_id === "string") {
      return (o as { subsidiary_id: string }).subsidiary_id;
    }
  } catch {
    // Broken metadata is treated as untagged.
  }
  return null;
}
