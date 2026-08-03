/**
 * Discord 向け transcript.frame の relay-side フィルタ集.
 *
 * `handleTranscriptFrame` は kind / role の絞り込み後、 本文を `dropPredicates`
 * の各述語に通す。 1 つでも true を返したら relay を skip する。
 *
 * 既存ルール:
 *   1. Codex の "guardian" subagent (action 認可判定) が出す JSON
 *      `{"risk_level":...,"user_authorization":...,"outcome":...,"rationale":...}`
 *      は人間向けの本文ではないので除外。
 *
 * 追加方法:
 *   - 単純な正規表現マッチ: `RegExp.prototype.test` を `(t) => re.test(t)` で
 *     wrap して push する。
 *   - 複雑な構造判定: text が JSON parse 可能で特定キーを持つか、 等を
 *     `(t) => { try { const o = JSON.parse(t); return !!o.risk_level; } catch { return false; } }`
 *     のように書く。
 *   - source-aware (provider 別) なフィルタが要るときは、 述語のシグネチャを
 *     `(text: string, context: { role: string }) => boolean` に拡張する。
 *     現状の用途では text-only で足りているのでシンプルに保つ。
 */

export type RelayDropPredicate = (text: string) => boolean;

// 情報文字列 `ask` のフェンス開始行。 行頭 (前置の空白のみ許容) に限定するのは
// `control/stalled-session-nudge.ts` の hasAskMarker と同じ判定にするため。 散文中で
// ask プロトコルに言及しただけの本文へ誤って警告を付けないようにする。
const ASK_MARKER_RE = /(^|\n)[ \t]*```ask\b/;

const UNSTRUCTURED_ASK_NOTICE =
  "⚠️ 質問カードを生成できませんでした。以下の質問へ通常のテキストで回答してください。";

/**
 * Lictor が構造化済みの ask マーカーは transcript 本文から消費され、質問カードとして
 * 別送される。生のマーカーが Concordia まで到達した場合は上流の構造化失敗なので、
 * JSON を黙って除去せず、警告付きの回答可能な本文として fail-loud に中継する。
 * @implements spec/feature/discord-lictor-relay.md — ask マーカーの fail-loud 中継
 */
export function renderUnstructuredAskFallback(text: string): string {
  const trimmed = text.trim();
  if (!ASK_MARKER_RE.test(trimmed)) return trimmed;
  return `${UNSTRUCTURED_ASK_NOTICE}\n\n${trimmed}`;
}

/**
 * Codex `guardian` subagent の認可判定 JSON 一致。 keys 順は不定なので
 * 全 4 キー存在を見るゆるめの判定にしている。
 */
const CODEX_GUARDIAN_JSON_RE =
  /"risk_level"\s*:\s*"[^"]+"[\s\S]*"user_authorization"\s*:\s*"[^"]+"[\s\S]*"outcome"\s*:\s*"[^"]+"/;

function isCodexGuardianJson(text: string): boolean {
  // 余白を許して JSON っぽい形か軽くチェックしてからの正規表現。 普通の散文に
  // たまたまこの 3 ワードが含まれる可能性は実用上ないが、 念のため `{` で
  // 始まる場合だけ走らせる。
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return false;
  return CODEX_GUARDIAN_JSON_RE.test(text);
}

export const dropPredicates: RelayDropPredicate[] = [
  isCodexGuardianJson,
];

/**
 * 全 predicate に通して 1 つでも true なら true (= drop)。 個別の判定理由を
 * ログに出したい場合は predicate に名前を付けて見つけられるようにする。
 */
export function shouldDropForRelay(text: string): boolean {
  for (const p of dropPredicates) {
    if (p(text)) return true;
  }
  return false;
}
