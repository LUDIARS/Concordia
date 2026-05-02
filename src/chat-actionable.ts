/**
 * チャット投稿が "action 提案" を含むかをルールベース判定.
 *
 * v0.1 はキーワード方式. 該当時は `chat_messages.is_actionable=1` で記録し、
 * 受信側 hook が AI に「ユーザ確認が要る」と促す.
 */

const ACTION_PATTERNS = [
  /(した方がいい|すべきだ|やった方が|追加した方が|直した方が)/,
  /(TODO|FIXME)/i,
  /(リファクタ|refactor)/i,
  /(削除|remove|消した方)/i,
  /(?:書き換え|rewrite)/i,
  /(?:対応してください|対応して欲しい|fix this)/i,
];

export function isActionableSuggestion(text: string): boolean {
  return ACTION_PATTERNS.some((re) => re.test(text));
}
