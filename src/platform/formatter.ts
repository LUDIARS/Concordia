export function formatAuthorName(displayName: string | null, role: string | null): string {
  const name = displayName?.trim();
  const r = role?.trim();
  if (name && r && name !== r) return `${name} (${r})`;
  return name ?? r ?? "Concordia";
}
