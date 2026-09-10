// @spec ハーネス信頼性の実装境界
/** Augur-compatible observe-only boundary. No model calls, arguments or exceptions are logged. */
import { vgWrite } from "../../shared/vestigium.js";
import { recordContractMetric } from "./ontime-metrics.js";

type Predicate = (...args: any[]) => boolean | string;
export interface ContractSpec {
  contractId: string; id: string; where: string; rule: string; mode: "observe"; sample: number;
  pre?: Predicate; post?: Predicate; postThrow?: Predicate; invariant?: Predicate;
}
export type ContractSink = (message: string, context: Record<string, unknown>) => void;
const productionSink: ContractSink = (message, context) => { recordContractMetric(message, context); vgWrite("info", message, context); };

/** Sink injection belongs to the wrapper instance; tests cannot replace the process-wide production sink. */
export function contract<F extends (this: any, ...args: any[]) => any>(fn: F, spec: ContractSpec, sink: ContractSink = productionSink): F {
  return function (this: unknown, ...args: Parameters<F>): ReturnType<F> {
    // Invalid instrumentation must not change application behavior or fabricate evidence.
    if (spec.mode !== "observe" || !(spec.sample > 0 && spec.sample <= 1) || Math.random() >= spec.sample) return fn.apply(this, args);
    let violated = false;
    const emit = (message: string, phase: string) => {
      try { sink(message, { contract: spec.contractId, id: spec.id, where: spec.where, rule: spec.rule, phase,
        observed_at: new Date().toISOString() }); } catch { /* Observability never changes application behavior. */ }
    };
    const check = (phase: "pre" | "post" | "postThrow" | "invariant", values: unknown[]) => {
      const predicate = spec[phase];
      if (!predicate) return;
      try {
        if (predicate(...values) !== true) { violated = true; emit("contract violated", phase); }
      } catch { violated = true; emit("contract predicate threw", "predicate"); }
    };
    check("pre", args);
    const success = (value: unknown) => {
      check("post", [value, ...args]); check("invariant", [this, ...args]);
      if (!violated) emit("contract observed", "ok");
      return value;
    };
    const failure = (error: unknown): never => {
      if (spec.postThrow) {
        check("postThrow", [error, ...args]); check("invariant", [this, ...args]);
        if (!violated) emit("contract observed", "ok");
      } else emit("contract violated", "postThrow");
      throw error;
    };
    let result: ReturnType<F>;
    try { result = fn.apply(this, args); } catch (error) { return failure(error); }
    if ((result as unknown) instanceof Promise) return (result as Promise<unknown>).then(success, failure) as ReturnType<F>;
    return success(result) as ReturnType<F>;
  } as F;
}
