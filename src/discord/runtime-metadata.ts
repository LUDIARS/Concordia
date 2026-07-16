export interface RuntimeMetadata {
  model?: string | null;
  effortLevel?: string | null;
  fastMode?: boolean | null;
  branch?: string | null;
}

export function formatWorkingBranch(branch: string | null | undefined): string {
  const value = branch?.trim();
  if (!value) return "`-`";
  return isRootBranch(value)
    ? `root \`${value}\``
    : `🟠 non-root \`${value}\``;
}

export function formatFastMode(value: boolean | null | undefined): string {
  if (value === true) return "⚡ ON";
  if (value === false) return "OFF";
  return "-";
}

function isRootBranch(branch: string): boolean {
  const value = branch.toLowerCase();
  return value === "main" || value === "master";
}
