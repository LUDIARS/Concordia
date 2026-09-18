import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export function contract(fn, spec) {
  return function (...args) {
    try {
      const result = fn.apply(this, args);
      const passed = spec.post === undefined || spec.post(result, ...args) === true;
      write(passed ? "contract observed" : "contract violated", spec, passed ? "ok" : "post");
      return result;
    } catch (error) {
      write("contract violated", spec, "postThrow");
      throw error;
    }
  };
}

function write(msg, spec, phase) {
  const directory = resolve(process.env.VESTIGIUM_LOGS_DIR ?? "logs");
  mkdirSync(directory, { recursive: true });
  appendFileSync(resolve(directory, "augur-contracts.jsonl"), `${JSON.stringify({ time: new Date().toISOString(), msg, ctx: { contract: spec.contractId, id: spec.id, where: spec.where, rule: spec.rule, phase, observed_at: new Date().toISOString() } })}\n`);
}
