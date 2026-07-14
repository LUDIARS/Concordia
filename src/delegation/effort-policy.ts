import type { DelegationProvider } from "../db/delegation-repo.js";

export const AUTO_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type AutoEffortLevel = typeof AUTO_EFFORT_LEVELS[number];
export type EffortTaskBucket = "routine" | "implementation" | "complex";

export function supportsAutomaticEffort(provider: DelegationProvider): boolean {
  return provider === "codex" || provider === "claude";
}

export function classifyEffortTask(prompt: string): EffortTaskBucket {
  const normalized = prompt.toLowerCase();
  const complexSignals = [
    "architecture", "migration", "migrate", "refactor", "security", "race condition",
    "root cause", "cross-cutting", "breaking change", "distributed", "redesign",
    "\u8a2d\u8a08\u5909\u66f4", "\u79fb\u884c", "\u30ea\u30d5\u30a1\u30af\u30bf", "\u539f\u56e0\u8abf\u67fb",
    "\u7af6\u5408", "\u30bb\u30ad\u30e5\u30ea\u30c6\u30a3", "\u6a2a\u65ad",
  ];
  if (prompt.length >= 3_000 || complexSignals.some((signal) => normalized.includes(signal))) return "complex";
  const implementationSignals = [
    "implement", "fix", "test", "api", "database", "schema", "component", "feature",
    "\u5b9f\u88c5", "\u4fee\u6b63", "\u30c6\u30b9\u30c8", "\u8ffd\u52a0", "\u5909\u66f4", "\u4e0d\u5177\u5408",
    "\u30c7\u30fc\u30bf\u30d9\u30fc\u30b9",
  ];
  if (prompt.length >= 600 || implementationSignals.some((signal) => normalized.includes(signal))) return "implementation";
  return "routine";
}

export function baselineEffort(bucket: EffortTaskBucket): AutoEffortLevel {
  if (bucket === "routine") return "low";
  if (bucket === "implementation") return "medium";
  return "xhigh";
}

export function normalizeAutomaticEffort(value: unknown): AutoEffortLevel | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (AUTO_EFFORT_LEVELS as readonly string[]).includes(normalized)
    ? normalized as AutoEffortLevel
    : null;
}
