/**
 * Astra With Sidecar のプロファイル定義と、テンプレートとの一致判定。
 *
 * 親は Astra (判断・設計・採否)、子は Sol medium (境界の定まった実務)。
 * 値はテンプレート seed (seed.ts) と起動側 (invoke-guard.ts) の両方がここを読む。
 * 指定外のモデルへ黙って切り替えないため、不一致は「停止理由」として返す。
 *
 * @implements spec/feature/astra-with-sidecar.md §モデル選択と委任契約
 */

import { initialRoleModel } from "../../model-catalog/role-policy.js";
export const ASTRA_WITH_SIDECAR_CALL_NAME = "astra-with-sidecar";
export const ASTRA_WITH_SIDECAR_TITLE = "Astra With Sidecar";

export interface SidecarModelSpec {
  call_name: string;
  provider: "codex";
  model: string;
  effort: "medium";
}

export const ASTRA_WITH_SIDECAR_PROFILE = {
  parent: { call_name: ASTRA_WITH_SIDECAR_CALL_NAME, provider: "codex", model: "gpt-6-astra", effort: "medium" },
  child: { call_name: "sol-mid", provider: "codex", model: initialRoleModel("sol"), effort: "medium" },
  /** 初期同時実行数。親子の同じファイルへの同時編集を避けるため 1 から始める。 */
  maxConcurrentChildren: 1,
  /** 同じ依頼 (task_reference + request_version) を子へ出し直せる回数の上限。 */
  maxAttemptsPerRequest: 3,
} as const satisfies {
  parent: SidecarModelSpec;
  child: SidecarModelSpec;
  maxConcurrentChildren: number;
  maxAttemptsPerRequest: number;
};

/** テンプレートのうち一致判定に使う列だけ。 DB 行でも seed 入力でも渡せる。 */
export interface SidecarTemplateFacts {
  call_name: string;
  is_active: boolean | number;
  target_provider: string;
  model: string | null;
  runtime_options_json?: string | null;
}

export type ProfileMismatchCode =
  | "sidecar_template_missing"
  | "sidecar_template_inactive"
  | "sidecar_provider_mismatch"
  | "sidecar_model_mismatch"
  | "sidecar_effort_mismatch";

export type ProfileCheck =
  | { ok: true }
  | { ok: false; code: ProfileMismatchCode; detail: string };

/**
 * テンプレートが仕様の provider / model / effort と一致するか。
 * 一致しなければ起動しない (利用不能を明示し、別モデルへの置換はしない)。
 */
export function checkTemplateMatchesSpec(
  spec: SidecarModelSpec,
  template: SidecarTemplateFacts | null,
): ProfileCheck {
  if (!template) {
    return { ok: false, code: "sidecar_template_missing", detail: `template ${spec.call_name} is not registered` };
  }
  if (!template.is_active) {
    return { ok: false, code: "sidecar_template_inactive", detail: `template ${spec.call_name} is inactive` };
  }
  if (template.target_provider !== spec.provider) {
    return {
      ok: false,
      code: "sidecar_provider_mismatch",
      detail: `template ${spec.call_name} uses provider ${template.target_provider}, expected ${spec.provider}`,
    };
  }
  if ((template.model ?? "").trim() !== spec.model) {
    return {
      ok: false,
      code: "sidecar_model_mismatch",
      detail: `template ${spec.call_name} uses model ${template.model ?? "(none)"}, expected ${spec.model}`,
    };
  }
  const effort = readTemplateEffort(template.runtime_options_json ?? null);
  if (effort !== spec.effort) {
    return {
      ok: false,
      code: "sidecar_effort_mismatch",
      detail: `template ${spec.call_name} uses effort ${effort ?? "(none)"}, expected ${spec.effort}`,
    };
  }
  return { ok: true };
}

function readTemplateEffort(runtimeOptionsJson: string | null): string | null {
  if (!runtimeOptionsJson) return null;
  try {
    const parsed = JSON.parse(runtimeOptionsJson) as Record<string, unknown>;
    const value = parsed.model_reasoning_effort ?? parsed.reasoning_effort ?? parsed.effort;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** セッション metadata の `delegation_call_name` から、そのセッションが Sidecar 親かを判定する。 */
export function isSidecarParentMetadata(metadata: string | null | undefined): boolean {
  if (!metadata) return false;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return parsed.delegation_call_name === ASTRA_WITH_SIDECAR_CALL_NAME;
  } catch {
    return false;
  }
}
