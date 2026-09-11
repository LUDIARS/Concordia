export function serviceDeploymentContract(result: { duplicate: boolean; delivered: number; fallback: boolean }): boolean {
  return result.duplicate || result.delivered >= 0 || result.fallback;
}
