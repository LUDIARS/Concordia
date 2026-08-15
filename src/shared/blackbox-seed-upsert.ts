/**
 * BlackBox シードルールの upsert。
 *
 * `when` / `output` を書き換えると `ruleFingerprint` が変わって**別ルール**になるため、
 * insert-once のシード投入ではコード側の変更が既存 DB に反映されない。 旧ルールが
 * `auto` のまま残って発火し続け、 「コードを直したのに挙動が変わらない」 稼働環境が生まれる。
 *
 * ここでは **コード側の seed を正本**として扱う:
 *  1. 同じ同一性キーを持つ旧 seed (現行 fingerprint 以外) を `retired` にする → 発火しなくなる
 *  2. 現行 fingerprint が未登録なら追加し、 登録済みなら `auto` へ戻す (撤回/降格からの復帰)
 *
 * これで再起動だけでコード側の seed が確実に効く。
 *
 * 同一性キーの導き方はドメインごとに違う (harness gate は verdict の代表 predicate 名、
 * completion は output の verdict 文字列) ため、 呼び出し側が `keyOf` で渡す。
 */

import { ruleFingerprint, type BlackBox, type Rule, type RuleDraft } from "@ludiars/blackbox";

/** 同一性キー付きのシード定義。 `key` は DB へは保存せず upsert の照合にだけ使う。 */
export type KeyedSeed<D extends RuleDraft = RuleDraft> = D & { key: string };

export interface SeedUpsertDeps {
  box: BlackBox;
  /** 既存ルールから同一性キーを導く。 導けないルールは空文字を返す。 */
  keyOf: (rule: Rule) => string;
}

/** シード 1 件を upsert する。 */
export function upsertSeedRule(deps: SeedUpsertDeps, draft: KeyedSeed): void {
  const fingerprint = ruleFingerprint(draft.when, draft.output);
  retireStaleSeeds(deps, draft.domain, draft.key, fingerprint);

  const existing = deps.box.rules.findByFingerprint(draft.domain, fingerprint);
  if (existing) {
    // 撤回・降格されていても、 コード側が正本なので auto へ戻す。
    if (existing.state !== "auto") deps.box.engine.setRuleState(existing.id, "auto");
    return;
  }
  const { key: _key, ...rule } = draft;
  deps.box.engine.addRule(rule);
}

/** シード一覧をまとめて upsert する。 */
export function upsertSeedRules(deps: SeedUpsertDeps, drafts: readonly KeyedSeed[]): void {
  for (const draft of drafts) upsertSeedRule(deps, draft);
}

/** 同一性キーが一致する旧シード (現行 fingerprint 以外) を retired にする。 */
function retireStaleSeeds(
  deps: SeedUpsertDeps,
  domain: string,
  key: string,
  keepFingerprint: string,
): void {
  for (const rule of deps.box.engine.listRules(domain)) {
    if (rule.source !== "seed" || rule.state === "retired") continue;
    if (rule.fingerprint === keepFingerprint) continue;
    if (deps.keyOf(rule) !== key) continue;
    deps.box.engine.setRuleState(rule.id, "retired");
  }
}
