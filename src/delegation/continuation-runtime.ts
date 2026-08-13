import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { InvokeInput } from "./contracts.js";

type InheritedRuntime = Pick<InvokeInput, "options" | "overrides">;

/** Preserve the canonical runtime identity when unfinished work moves to a replacement run. */
export function inheritDelegationRuntime(run: DelegationRunRow): InheritedRuntime {
  const options = {
    ...(run.team_id ? { team: run.team_id } : {}),
    ...(run.fast_mode === 1 ? { fast_mode: true } : {}),
  };
  return {
    options: Object.keys(options).length > 0 ? options : undefined,
    overrides: {
      provider: run.target_provider,
      ...(run.effective_model ? { model: run.effective_model } : {}),
      ...(run.effort_level ? { reasoning_effort: run.effort_level } : {}),
    },
  };
}
