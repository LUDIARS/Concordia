/**
 * セクションチャンネルの添付を取り直す口 (port)。 API (src/api) は Discord を直接読まず、
 * この型だけに依存する。 実装は src/discord/team-attachment-fetcher.ts、 配線は bootstrap/core.ts。
 *
 * @implements spec/feature/discord-notion-sync.md — 画像・添付
 */

export interface TeamDiscussionAttachmentView {
  kind: "image" | "file";
  name: string;
  size: number;
  /** Cc と同じ機械に保存したファイルの絶対パス。 */
  path: string;
  /** Discord の CDN URL。 署名付きで約 24 時間で切れる。 保存せず、 その場の取得にだけ使う。 */
  url: string;
}

export type TeamAttachmentFetchResult =
  | { ok: true; attachments: TeamDiscussionAttachmentView[] }
  | { ok: false; error: "discord_api_error" }
  | { ok: false; error: "store_failed"; detail: string };

export interface TeamAttachmentFetcher {
  fetch(input: { teamId: string; channelId: string; messageId: string }): Promise<TeamAttachmentFetchResult>;
}
