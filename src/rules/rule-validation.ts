/**
 * rule 定義の実効検証 (更新後の全体を見る)。 PUT / PATCH / toggle-enable / rollback が共通で使う
 * (spec/feature/patrol-chat.md §5 / CC-PATROL-08)。
 */

import type { RuleRow, TriggerType } from "../db/rules-repo.js";
import { parseActionConfig, reviewPatrolConfig, type SourceLookup, type SubsidiaryPatrolDefaults } from "./patrol-config.js";
import { reviewRule, type ReviewResult } from "./review.js";

export type RuleDefinition = Pick<
  RuleRow,
  | "id" | "description" | "trigger_type" | "tick_sec" | "event_kind" | "conditions" | "instructions"
  | "target" | "cooldown_sec" | "config_version" | "execution_mode" | "action_config"
> & { subsidiary_id?: string | null };

/**
 * @param inherit 持ち主の子会社の既定値 (引き継いだ値も含めた実効設定で検証する)。
 */
export function validateRuleDefinition(
  def: RuleDefinition,
  sources: SourceLookup,
  inherit?: SubsidiaryPatrolDefaults | null,
): ReviewResult {
  const base = reviewRule({
    id: def.id,
    description: def.description,
    trigger_type: def.trigger_type as TriggerType,
    tick_sec: def.tick_sec,
    event_kind: def.event_kind,
    target: def.target,
    cooldown_sec: def.cooldown_sec,
    instructions: def.instructions,
  });
  if (!base.ok) return base;
  try {
    const conds = JSON.parse(def.conditions) as unknown;
    if (!Array.isArray(conds)) return { ok: false, reason: "conditions は配列であること" };
  } catch {
    return { ok: false, reason: "conditions が JSON として読めない" };
  }
  if (def.config_version === 1) {
    if (def.execution_mode !== "legacy-observe") return { ok: false, reason: "config_version=1 は legacy-observe のみ" };
    if (def.action_config !== null) return { ok: false, reason: "config_version=1 に action_config は置けない" };
    return { ok: true };
  }
  if (def.config_version !== 2) return { ok: false, reason: `未知の config_version: ${def.config_version}` };
  if (def.execution_mode !== "patrol") return { ok: false, reason: "config_version=2 は execution_mode=patrol" };
  const parsed = parseActionConfig(def.action_config, inherit);
  if (!parsed.ok) return parsed;
  return reviewPatrolConfig(
    { trigger_type: def.trigger_type, event_kind: def.event_kind, config: parsed.config, subsidiaryId: def.subsidiary_id ?? null },
    sources,
  );
}
