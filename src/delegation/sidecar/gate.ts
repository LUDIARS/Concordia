/**
 * Sidecar 起動の可否判定 (純関数)。
 *
 * 親が Astra With Sidecar のとき、子の起動を次の条件で絞る。
 * - 子テンプレートは profile の child だけ。 親の model / effort を子へ持ち込まない。
 * - 同時実行は maxConcurrentChildren まで。 結果不明の起動 (queued / launching 等) も数える
 *   — 未起動と断定して二重起動しないため。
 * - 同じ依頼 (task_reference + 依頼版) の出し直しは maxAttemptsPerRequest まで。
 * - 子の branch は親の branch と別にする (同じファイルへの同時編集を避ける)。
 *
 * @implements spec/feature/astra-with-sidecar.md §モデル選択と委任契約 / §不変条件と復旧
 */

import { ASTRA_WITH_SIDECAR_PROFILE, checkTemplateMatchesSpec, type ProfileMismatchCode, type SidecarTemplateFacts } from "./profile.js";
import { sidecarRequestKey, type SidecarPacket } from "./packet.js";

/** 同時実行枠を占有しているとみなす run 状態。 終端 (completed / failed / spawn_failed) 以外すべて。 */
const OCCUPYING_STATUSES = new Set(["queued", "launching", "pending", "spawned", "running", "blocked"]);

export interface SidecarChildRunFacts {
  id: string;
  status: string;
  /** 子 run の args に保存した依頼キー。 旧 run や通常委託は null。 */
  request_key: string | null;
}

export interface SidecarGateInput {
  requestedCallName: string;
  childTemplate: SidecarTemplateFacts | null;
  packet: SidecarPacket;
  /** 同じ親セッションが出した子 run (新しい順)。 */
  childRuns: readonly SidecarChildRunFacts[];
  /** 親の現在の作業 branch (不明なら null)。 */
  parentBranch: string | null;
  /** 親が provider / model / effort の上書きを要求したか。 */
  requestedOverride: { provider?: string; model?: string | null; reasoning_effort?: string } | null;
}

export type SidecarGateCode =
  | ProfileMismatchCode
  | "sidecar_child_template_mismatch"
  | "sidecar_override_rejected"
  | "sidecar_concurrency_limit"
  | "sidecar_attempt_limit"
  | "sidecar_branch_conflict";

export type SidecarGateDecision =
  | { allow: true; requestKey: string; attempt: number }
  | { allow: false; code: SidecarGateCode; detail: string; blockingRunIds?: string[] };

export function decideSidecarInvoke(input: SidecarGateInput): SidecarGateDecision {
  const profile = ASTRA_WITH_SIDECAR_PROFILE;
  if (input.requestedCallName !== profile.child.call_name) {
    return {
      allow: false,
      code: "sidecar_child_template_mismatch",
      detail: `Astra With Sidecar delegates only to ${profile.child.call_name}; got ${input.requestedCallName}`,
    };
  }
  const templateCheck = checkTemplateMatchesSpec(profile.child, input.childTemplate);
  if (!templateCheck.ok) return { allow: false, code: templateCheck.code, detail: templateCheck.detail };

  const override = input.requestedOverride;
  if (override && (
    (override.provider !== undefined && override.provider !== profile.child.provider)
    || (override.model !== undefined && override.model !== null && override.model !== profile.child.model)
    || (override.reasoning_effort !== undefined && override.reasoning_effort !== profile.child.effort)
  )) {
    return {
      allow: false,
      code: "sidecar_override_rejected",
      detail: `sidecar runs ${profile.child.model} / ${profile.child.effort}; provider/model/effort overrides are not accepted`,
    };
  }

  if (input.parentBranch && input.packet.child_branch === input.parentBranch) {
    return {
      allow: false,
      code: "sidecar_branch_conflict",
      detail: `child_branch must differ from the parent branch (${input.parentBranch})`,
    };
  }

  const occupying = input.childRuns.filter((run) => OCCUPYING_STATUSES.has(run.status));
  if (occupying.length >= profile.maxConcurrentChildren) {
    return {
      allow: false,
      code: "sidecar_concurrency_limit",
      detail: `sidecar already has ${occupying.length} unfinished run(s); wait for the result or stop it first`,
      blockingRunIds: occupying.map((run) => run.id),
    };
  }

  const requestKey = sidecarRequestKey(input.packet);
  const previous = input.childRuns.filter((run) => run.request_key === requestKey).length;
  if (previous >= profile.maxAttemptsPerRequest) {
    return {
      allow: false,
      code: "sidecar_attempt_limit",
      detail: `${requestKey} was already delegated ${previous} time(s); keep it in the parent or raise request_version after changing the scope`,
    };
  }
  return { allow: true, requestKey, attempt: previous + 1 };
}
