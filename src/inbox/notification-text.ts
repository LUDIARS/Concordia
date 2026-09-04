/**
 * 通知へ再掲する未信頼テキストから、Discord / Slack の mention・特殊リンク構文を無効化する。
 * 管理職への正規の mention は、この変換後に notifier が別途付加する。
 *
 * @implements spec/feature/approval-inbox.md §3
 */
export function escapeNotificationText(text: string): string {
  return text.replaceAll("@", "＠").replaceAll("<", "‹").replaceAll(">", "›");
}
