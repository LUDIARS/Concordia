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

/**
 * Lictor の "ask マーカー" — assistant が選択肢付き質問を出すときの
 * ```` ```ask ```` フェンスドブロック (中身は JSON)。 Lictor がこれを構造化
 * パースして Discord の質問カード (embed + ボタン) を別途投稿するため、 生の
 * JSON ブロックを relay 本文として二重表示する必要はない。 ここで本文から
 * 除去する。 info 文字列は `ask`、 閉じフェンスは ``` (3 backtick)。
 */
const ASK_MARKER_BLOCK_RE = /```ask\b[\s\S]*?```/g;

/**
 * relay 本文から ask マーカーブロックを取り除いて trim する。 ブロックが無ければ
 * 入力をそのまま (trim だけ) 返す。 質問に添えられた散文があればそれは残る。
 */
export function stripAskMarkerBlocks(text: string): string {
  return text.replace(ASK_MARKER_BLOCK_RE, "").trim();
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
