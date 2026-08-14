import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionContract } from "./schema.js";
import { readRuntimeEffort, readRuntimeModel } from "./seed-rules.js";

export type ApplyModelEffortFn = (input: {
  sessionId: string;
  model: string;
  effort: string;
}) => Promise<{ ok: boolean; message: string }>;

export interface ContractModelEffortApplyResult {
  applied: boolean;
  ok?: boolean;
  message?: string;
}

const RUNTIME_SETTING_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

/**
 * 契約の model / effort 決定をセッション runtime (Lictor /v1/runtime/model-effort) へ反映する。
 *
 * - seed 決定は現 runtime の写しなので切替しない。
 * - どちらかが未決なら何もしない (Lictor endpoint は両方を要求する)。
 * - model 値が provider 名と一致し、 runtime の model が不明な場合は質問カードの
 *   「現 runtime 維持」プレースホルダなので切替しない (provider 名は model id ではない)。
 */
export async function applyContractModelEffort(input: {
  sessions: SessionsRepo;
  sessionId: string;
  contract: SessionContract;
  apply: ApplyModelEffortFn;
}): Promise<ContractModelEffortApplyResult> {
  const model = input.contract.model;
  const effort = input.contract.effort;
  if (!model || !effort) return { applied: false };
  if (model.decided_by === "seed" && effort.decided_by === "seed") return { applied: false };
  const row = input.sessions.findSession(input.sessionId);
  if (!row) return { applied: false };
  const currentModel = readRuntimeModel(row.metadata);
  const currentEffort = readRuntimeEffort(row.metadata);
  if (model.value === currentModel && effort.value === currentEffort) return { applied: false };
  if (currentModel === null && model.value === row.provider) return { applied: false };
  if (!RUNTIME_SETTING_PATTERN.test(model.value) || !RUNTIME_SETTING_PATTERN.test(effort.value)) {
    return {
      applied: false,
      ok: false,
      message: "contract model/effort contains characters that are unsafe for the runtime command boundary",
    };
  }
  const result = await input.apply({ sessionId: input.sessionId, model: model.value, effort: effort.value });
  return { applied: true, ok: result.ok, message: result.message };
}
