export type CostMode = "embedded" | "worker" | "off";

export function readCostMode(env: NodeJS.ProcessEnv = process.env): CostMode {
  const raw = (env.CONCORDIA_COST_MODE ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "worker") return raw;
  return "embedded";
}

export function costEmbeddedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readCostMode(env) === "embedded";
}
