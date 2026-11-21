/**
 * Opus の起動要求を、 agy の Claude 枠テンプレート (opus-agy-identity.ts) へ振り替える。
 *
 * Opus テンプレートの provider を書き換えず、 定義ごと振替先テンプレートに入れ替える。 run の
 * call_name・title・emoji が振替先になるので、 Discord・Web の起動表示で Gemini 起動だと分かる。
 *
 * 振り替えないもの: Opus 以外 / spawn しない (render のみ) / 呼び出し元が provider・model・model_tier を
 * 指定した / 振替先テンプレートが無い・無効。 判定 (effort・残量) は opus-agy-route.ts。
 *
 * @implements spec/feature/delegation-model-tiers.md DMT-07 DMT-08
 */
import { parseRuntimeOptions } from "../db/delegation-repo.js";
import type { DelegationDefinition, InvokeInput } from "./contracts.js";
import { OPUS_CALL_NAME } from "./opus-agy-identity.js";
import { agyOpusEffort, decideOpusAgyRoute, type OpusAgyRoute } from "./opus-agy-route.js";

export interface OpusAgyRerouteInput {
  def: DelegationDefinition;
  input: InvokeInput;
  /** 振替先テンプレートを scope 解決済みで返す。 無い・無効なら null。 */
  findAgyDefinition: () => DelegationDefinition | null;
  /** agy Claude 枠の残り % (取得失敗は null)。 */
  remainingPct: () => Promise<number | null>;
}

export type OpusAgyReroute =
  | { rerouted: true; def: DelegationDefinition; route: Extract<OpusAgyRoute, { route: "agy" }> }
  | { rerouted: false; reason: string };

export async function rerouteOpusToAgy(opts: OpusAgyRerouteInput): Promise<OpusAgyReroute> {
  const { def, input } = opts;
  if (def.call_name !== OPUS_CALL_NAME) return { rerouted: false, reason: "not_opus" };
  if (input.spawn === false) return { rerouted: false, reason: "render_only" };
  if (input.model_tier || input.overrides?.provider !== undefined || input.overrides?.model !== undefined) {
    return { rerouted: false, reason: "explicit_route" };
  }
  const requestedEffort = findOpusEffort(def, input);
  // effort が agy に無い段なら残量を取りに行かない (I/O を省く)。
  if (!agyOpusEffort(requestedEffort)) return { rerouted: false, reason: "effort_unsupported" };
  const target = opts.findAgyDefinition();
  if (!target) return { rerouted: false, reason: "agy_template_unavailable" };
  const route = decideOpusAgyRoute({ requestedEffort, remainingPct: await opts.remainingPct() });
  if (route.route !== "agy") return { rerouted: false, reason: route.reason };
  return { rerouted: true, def: { ...target, model: route.model }, route };
}

/** Opus テンプレートに対する effort 要求 (上書き > 1 回指定 > テンプレート既定)。 */
function findOpusEffort(def: DelegationDefinition, input: InvokeInput): unknown {
  if (input.overrides?.reasoning_effort !== undefined) return input.overrides.reasoning_effort;
  const oneShot = input.options ?? {};
  const template = parseRuntimeOptions(def.runtime_options_json);
  for (const source of [oneShot, template]) {
    for (const key of ["effort", "reasoning_effort"]) {
      if (source[key] !== undefined) return source[key];
    }
  }
  return undefined;
}
