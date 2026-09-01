/**
 * 表示・保存の直前に資格情報らしき文字列を伏せる最後の境界。
 *
 * 元は `delegation/status-card-projection.ts` と `discord/test-forum-discord.ts` に
 * 同じ実装が 2 本あった。 失敗したツール呼び出しの内訳 (messages/tool-failure.ts) でも
 * 同じ手当てが要るため、 3 本目を増やさず共通化する。
 *
 * これは**保険**であって認可ではない。 秘密を出さない一次の担保は、 そもそも秘密を
 * 載せない経路設計の側にある (RULE_CODE §14)。
 */

/**
 * Bearer トークン / OpenAI・GitHub・Slack 形式のキー / credential 名を持つ環境変数・
 * CLI 引数を伏せる。 見つからなければ入力をそのまま返す。
 */
export function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|gh[pousr][_-]|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /\b([A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|secret[_-]?access[_-]?key|client[_-]?secret|token|secret|password))\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /(--(?:api[_-]?key|access[_-]?token|client[_-]?secret|token|secret|password)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1[REDACTED]",
    );
}
