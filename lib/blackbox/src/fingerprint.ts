// ルール指紋と output 同値判定。 純粋関数のみ。
//
// 指紋 = when + output の「キー順に依存しない」正規化 JSON。
// LLM は同じルールを毎回微妙に違う語順・説明文で提案してくるため、
// description は含めず論理内容 (when/output) だけで同一性を取る。

/** 値を キー昇順・配列順保持 で決定的に直列化する。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortValue(src[k]);
    return out;
  }
  return value ?? null;
}

/** ルールの論理内容の指紋。 同 domain 内の重複提案マージ・撤回後の再提案ブロックに使う。 */
export function ruleFingerprint(when: unknown, output: unknown): string {
  return canonicalJson({ when, output });
}

/** output 同士の同値判定 (影評価の一致/不一致)。 */
export function sameOutput(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
