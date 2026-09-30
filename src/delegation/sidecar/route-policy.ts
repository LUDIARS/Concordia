/**
 * 作業の振り分け (親保持 / Sidecar / 確認待ち) の決定的判定。
 *
 * 毎メッセージではなく、作業の受付時と範囲が変わった時に親が呼ぶ。 まず決定的条件で
 * 決め、決まらない時だけ分類器 (差し替え可能な口) を使う。 分類器が無い・落ちた・不確実な
 * 場合は親保持に倒す — 許可や範囲を広げる方向には決して倒さない。
 * 分類器のモデルと閾値は設定・計測の対象で、ここに精度の仮定は置かない。
 *
 * @implements spec/feature/astra-with-sidecar.md §モデル選択と委任契約 / §不変条件と復旧
 */

export type SidecarRoute = "parent" | "sidecar" | "clarify";

export type SidecarWorkKind =
  | "ui_tweak"
  | "known_spec_branch"
  | "list_or_text"
  | "doc_extraction"
  | "local_fix_with_repro"
  | "cross_cutting_design"
  | "root_cause_unknown"
  | "other";

export type SidecarSize = "tiny" | "small" | "medium" | "large";

export interface SidecarRouteInput {
  kind: SidecarWorkKind;
  size: SidecarSize;
  /** 受入条件が検証可能な形で揃っているか。 */
  acceptanceDefined: boolean;
  /** 編集範囲 (パス) が決まっているか。 */
  scopeDefined: boolean;
  /** 権限・データ移行・破壊的変更を含むか。 */
  sensitive: boolean;
  /** 親の判断を要する未決事項が残っているか。 */
  openQuestions: boolean;
}

export type SidecarRouteReason =
  | "acceptance_undefined"
  | "open_questions"
  | "sensitive_change"
  | "cross_cutting_design"
  | "root_cause_unknown"
  | "scope_undefined"
  | "too_small_to_delegate"
  | "bounded_work"
  | "classifier_unavailable"
  | "classifier_uncertain"
  | "classifier_decided";

export interface SidecarRouteDecision {
  route: SidecarRoute;
  reason: SidecarRouteReason;
  uncertainty: "low" | "high";
  source: "deterministic" | "classifier" | "fallback";
  /** 子へ出す場合の概算 (分)。 親保持なら null。 */
  budgetMinutes: number | null;
}

/** 分類器の口。 未設定・例外・不確実は親保持として扱う。 */
export interface SidecarRouteClassifier {
  classify(input: SidecarRouteInput): Promise<{ route: SidecarRoute; confident: boolean; model: string } | null>;
}

const BUDGET_MINUTES: Record<SidecarSize, number> = { tiny: 10, small: 20, medium: 45, large: 90 };
const BOUNDED_KINDS = new Set<SidecarWorkKind>([
  "ui_tweak",
  "known_spec_branch",
  "list_or_text",
  "doc_extraction",
  "local_fix_with_repro",
]);

/** 決定的に決まる場合はその判定、決まらない場合は null (分類器へ回す)。 */
export function decideSidecarRouteDeterministic(input: SidecarRouteInput): SidecarRouteDecision | null {
  const hold = (route: SidecarRoute, reason: SidecarRouteReason): SidecarRouteDecision => ({
    route, reason, uncertainty: "low", source: "deterministic", budgetMinutes: null,
  });
  if (!input.acceptanceDefined) return hold("clarify", "acceptance_undefined");
  if (input.openQuestions) return hold("clarify", "open_questions");
  if (input.sensitive) return hold("parent", "sensitive_change");
  if (input.kind === "cross_cutting_design") return hold("parent", "cross_cutting_design");
  if (input.kind === "root_cause_unknown") return hold("parent", "root_cause_unknown");
  if (!input.scopeDefined) return hold("parent", "scope_undefined");
  // 分類・起動・引継ぎの固定費が本体を上回る委任は避け、まとめて親で済ませる。
  if (input.size === "tiny") return hold("parent", "too_small_to_delegate");
  if (BOUNDED_KINDS.has(input.kind) && input.size !== "large") {
    return {
      route: "sidecar",
      reason: "bounded_work",
      uncertainty: "low",
      source: "deterministic",
      budgetMinutes: BUDGET_MINUTES[input.size],
    };
  }
  return null;
}

export async function decideSidecarRoute(
  input: SidecarRouteInput,
  classifier: SidecarRouteClassifier | null,
): Promise<SidecarRouteDecision & { classifierModel: string | null }> {
  const deterministic = decideSidecarRouteDeterministic(input);
  if (deterministic) return { ...deterministic, classifierModel: null };
  const fallback = (reason: SidecarRouteReason, model: string | null) => ({
    route: "parent" as const, reason, uncertainty: "high" as const, source: "fallback" as const,
    budgetMinutes: null, classifierModel: model,
  });
  if (!classifier) return fallback("classifier_unavailable", null);
  let result: Awaited<ReturnType<SidecarRouteClassifier["classify"]>>;
  try {
    result = await classifier.classify(input);
  } catch {
    return fallback("classifier_unavailable", null);
  }
  if (!result) return fallback("classifier_unavailable", null);
  if (!result.confident) return fallback("classifier_uncertain", result.model);
  return {
    route: result.route,
    reason: "classifier_decided",
    uncertainty: "low",
    source: "classifier",
    budgetMinutes: result.route === "sidecar" ? BUDGET_MINUTES[input.size] : null,
    classifierModel: result.model,
  };
}
