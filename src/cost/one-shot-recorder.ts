import { currentDb } from "../db/index.js";
import { CostOneShotCallsRepo, type CostOneShotInput } from "../db/cost-one-shot-calls-repo.js";

export function recordLocalOneShot(input: CostOneShotInput): void {
  try {
    new CostOneShotCallsRepo(currentDb()).insert(input);
  } catch {
    // Cost monitoring must not affect the caller path.
  }
}
