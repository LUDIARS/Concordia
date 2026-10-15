/**
 * 巡回 rule の試し見 (spec/feature/patrol-chat.md §9 `POST /v1/rules/preview`)。
 *
 * 副作用なし・LLM なし。 素材元を読んで候補と score、 seed で決まる選択結果、 投稿されない理由を返す。
 * run も会話も作らず、 chat にも書かない。
 */

import type { RuleRow } from "../db/rules-repo.js";
import type { MaterialSourceRegistry } from "./material-registry.js";
import { MaterialSourceError, type Material } from "./material-types.js";
import { parseActionConfig } from "./patrol-config.js";
import { pickMaterial, seededRandom } from "./patrol-policy.js";

export interface PreviewResult {
  ok: boolean;
  reason: string;
  seed: number;
  candidateCount: number;
  scored: Array<{ itemId: string; score: number }>;
  picked: Pick<Material, "itemId" | "title" | "excerpt" | "url" | "serviceCode" | "featureKey" | "occurredAt"> | null;
  sourceErrors: Array<{ sourceId: string; code: string; message: string }>;
}

export async function previewPatrolRule(
  rule: Pick<RuleRow, "id" | "action_config">,
  deps: {
    sources: MaterialSourceRegistry;
    usedItemIds: Set<string>;
    nowMs: number;
    seed: number;
  },
): Promise<PreviewResult> {
  const parsed = parseActionConfig(rule.action_config);
  const empty = { seed: deps.seed, candidateCount: 0, scored: [], picked: null, sourceErrors: [] };
  if (!parsed.ok) return { ok: false, reason: parsed.reason, ...empty };
  const config = parsed.config;
  const since = new Date(deps.nowMs - config.filters.max_age_sec * 1000).toISOString();
  const items: Material[] = [];
  const sourceErrors: PreviewResult["sourceErrors"] = [];
  for (const sourceId of config.source_ids) {
    try {
      const page = await deps.sources.resolve(sourceId).list({
        since, limit: 100, scopeKey: config.scope_key, ...(config.filters.genres?.length ? { genres: config.filters.genres } : {}),
      });
      items.push(...page.items);
    } catch (err) {
      sourceErrors.push({
        sourceId,
        code: err instanceof MaterialSourceError ? err.code : "unavailable",
        message: (err as Error).message,
      });
    }
  }
  const pick = pickMaterial(items, {
    nowMs: deps.nowMs,
    scopeKey: config.scope_key,
    config,
    usedItemIds: deps.usedItemIds,
    random: seededRandom(deps.seed),
  });
  return {
    ok: !!pick.picked,
    reason: pick.picked ? pick.reason : sourceErrors.length > 0 && items.length === 0 ? "source error" : pick.reason,
    seed: deps.seed,
    candidateCount: pick.candidateCount,
    scored: pick.scored,
    picked: pick.picked
      ? {
          itemId: pick.picked.itemId,
          title: pick.picked.title,
          excerpt: pick.picked.excerpt,
          url: pick.picked.url,
          serviceCode: pick.picked.serviceCode,
          featureKey: pick.picked.featureKey,
          occurredAt: pick.picked.occurredAt,
        }
      : null,
    sourceErrors,
  };
}
