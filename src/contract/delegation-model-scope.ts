import { modelReviewProvider } from "./model-review-adapter.js";
import type { SessionContract } from "./schema.js";

export interface DelegationModelRequest {
  model?: string | null;
  reasoning_effort?: string;
}

/**
 * 親セッションの作業契約 (model / effort) を委託の上書きへ入れてよいか。
 *
 * 契約の model / effort は親セッションの provider 向けの値 (claude-opus-5-5 / max 等)。
 * provider の違う委託 (Claude 親 → Codex テンプレート) へそのまま入れると、Codex に
 * `--model claude-opus-5-5` が渡り起動直後に 400 で止まる (Actio 042b0e71)。
 * 同じ系統 (claude 同士 / codex 同士) のときだけ契約を優先し、違う・判定できないときは
 * 呼び出し側の指定 (無ければテンプレート既定) をそのまま使う。 純関数。
 */
export function contractModelOverrides(
  contract: Pick<SessionContract, "model" | "effort"> | null,
  parentProvider: string | null,
  delegationProvider: string | null,
  requested: DelegationModelRequest | undefined,
): DelegationModelRequest {
  const parentFamily = modelReviewProvider(parentProvider);
  const delegationFamily = modelReviewProvider(delegationProvider);
  const sameFamily = parentFamily !== null && parentFamily === delegationFamily;
  if (!contract || !sameFamily) {
    return { model: requested?.model, reasoning_effort: requested?.reasoning_effort };
  }
  return {
    model: contract.model?.value ?? requested?.model,
    reasoning_effort: contract.effort?.value ?? requested?.reasoning_effort,
  };
}
