/**
 * Discord の投稿の添付を、 画像と画像以外に分けて保存処理へ渡せる形にする。
 *
 * セッションのチャンネル (ingress.ts)、 テスト用フォーラム (test-forum-message.ts)、
 * チームのセクションチャンネル (team-discussion.ts) が同じ判定を使う。 投稿ごとに判定が
 * ずれると「ある面では画像が届き、 別の面では黙って消える」が起きるため 1 か所に置く。
 *
 * 純関数。 ダウンロード・保存は image-inbox.ts / attachment-inbox.ts が持つ。
 */

import type { DiscordFileAttachment } from "./attachment-inbox.js";
import { isDiscordImageAttachment, type DiscordImageAttachment } from "./image-inbox.js";

/** discord.js の Attachment のうち、 ここで読む部分。 */
export interface DiscordMessageAttachmentSource {
  id: string;
  contentType: string | null;
  name: string | null;
  size: number;
  url: string;
}

export interface SplitMessageAttachments {
  images: DiscordImageAttachment[];
  files: DiscordFileAttachment[];
}

/** 記録用の添付の情報。 CDN の URL は期限付きなので持たない (取り込み時に投稿を取り直す)。 */
export interface DiscordAttachmentMeta {
  id: string;
  name: string;
  content_type: string | null;
  size: number;
  kind: "image" | "file";
}

export function splitMessageAttachments(
  attachments: Iterable<DiscordMessageAttachmentSource>,
): SplitMessageAttachments {
  const images: DiscordImageAttachment[] = [];
  const files: DiscordFileAttachment[] = [];
  for (const attachment of attachments) {
    const entry = {
      contentType: attachment.contentType,
      name: attachment.name,
      size: attachment.size,
      url: attachment.url,
    };
    if (isDiscordImageAttachment(entry)) images.push(entry);
    else files.push(entry);
  }
  return { images, files };
}

export function describeMessageAttachments(
  attachments: Iterable<DiscordMessageAttachmentSource>,
): DiscordAttachmentMeta[] {
  return [...attachments].map((attachment) => ({
    id: attachment.id,
    name: attachment.name ?? "",
    content_type: attachment.contentType,
    size: attachment.size,
    kind: isDiscordImageAttachment({
      contentType: attachment.contentType,
      name: attachment.name,
      size: attachment.size,
      url: attachment.url,
    }) ? "image" : "file",
  }));
}
