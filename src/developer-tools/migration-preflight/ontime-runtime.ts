import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/** The CLI must not initialize the service logger, its transports or background handles. */
interface ContractSpec<Args extends unknown[], Result> {
  contractId: string; id: string; where: string; rule: string; mode: "observe"; sample: number;
  post?: (result: Result, ...args: Args) => boolean;
}

/** Optional Augur evidence goes only to an explicitly supplied log directory. */
export function contract<Args extends unknown[], Result>(
  fn: (...args: Args) => Result, spec: ContractSpec<Args, Result>,
): (...args: Args) => Result {
  return (...args) => {
    const result = fn(...args);
    const directory = process.env.VESTIGIUM_LOGS_DIR;
    if (!directory) return result;
    try {
      const passed = spec.post?.(result, ...args) === true;
      const time = new Date().toISOString();
      mkdirSync(directory, { recursive: true });
      appendFileSync(resolve(directory, "migration-preflight-contracts.jsonl"), JSON.stringify({
        time, msg: passed ? "contract observed" : "contract violated",
        ctx: { contract: spec.contractId, id: spec.id, where: spec.where, rule: spec.rule,
          phase: passed ? "ok" : "post", observed_at: time },
      }) + "\n", "utf8");
    } catch { /* Optional observation failures must never change this read-only command's result. */ }
    return result;
  };
}
