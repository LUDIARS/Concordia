import type { WorkdirOption } from "./delegation-modal.js";

export function listWorkdirOptions(roots: string[]): WorkdirOption[] {
  const seen = new Set<string>();
  const options: WorkdirOption[] = [];
  for (const root of roots) {
    const value = root.replace(/[\\/]+$/, "");
    if (!value || seen.has(value)) continue;
    seen.add(value);
    options.push({ label: value, value });
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

export function readSlackInputValue(values: unknown, blockId: string, actionId: string): string {
  const block = values && typeof values === "object" ? (values as Record<string, unknown>)[blockId] : null;
  const action = block && typeof block === "object" ? (block as Record<string, unknown>)[actionId] : null;
  const value = action && typeof action === "object" ? (action as { value?: unknown }).value : null;
  return typeof value === "string" ? value.trim() : "";
}
