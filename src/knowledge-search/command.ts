/**
 * Slack の「ナレッジ検索」コマンドの解釈 (spec/feature/slack-knowledge-search.md KS-1, KS-3)。
 *
 * SRP: 本文から検索語を取り出すだけ。 Slack の受信・返信は slack-adapter.ts。
 */

export const KNOWLEDGE_SEARCH_COMMAND = "ナレッジ検索";
export const KNOWLEDGE_SEARCH_USAGE = "使い方: `@Bot ナレッジ検索 <調べたい技術や語>`（ワークフローはステップ「ナレッジ検索」の検索語に入力）";
export const KNOWLEDGE_SEARCH_MAX_QUERY = 200;

export type SearchCommand =
  | { kind: "none" }
  | { kind: "usage" }
  | { kind: "search"; query: string };

/** 検索語を整える (空白を畳み、 上限で切る)。 */
export function normalizeQuery(raw: string): string {
  return Array.from(raw.normalize("NFKC").replace(/\s+/g, " ").trim()).slice(0, KNOWLEDGE_SEARCH_MAX_QUERY).join("");
}

/**
 * Bot へのメンション付きメッセージを解釈する。 Bot へのメンションを含み、 メンションを除いた本文が
 * 「ナレッジ検索」で始まるときだけコマンド。 bot user id が不明なら受け付けない。
 */
export function parseMentionCommand(text: string, botUserId: string | null): SearchCommand {
  if (!botUserId) return { kind: "none" };
  const mention = `<@${botUserId}>`;
  if (!text.includes(mention)) return { kind: "none" };
  const body = text.split(mention).join(" ").replace(/<@[UW][A-Z0-9]+>/g, " ").trim();
  if (!body.startsWith(KNOWLEDGE_SEARCH_COMMAND)) return { kind: "none" };
  const query = normalizeQuery(body.slice(KNOWLEDGE_SEARCH_COMMAND.length));
  return query ? { kind: "search", query } : { kind: "usage" };
}

/** ワークフローのステップ入力を解釈する。 */
export function parseWorkflowQuery(raw: string | undefined): Exclude<SearchCommand, { kind: "none" }> {
  const query = normalizeQuery(raw ?? "");
  return query ? { kind: "search", query } : { kind: "usage" };
}
