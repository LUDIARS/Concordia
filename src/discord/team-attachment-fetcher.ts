/**
 * セクションチャンネルの投稿を取り直し、 添付をチーム専用の置き場所へ保存する。
 *
 * 保存は既存の受信箱 (image-inbox / attachment-inbox) をそのまま使う。 取得先の制限 (Discord CDN のみ)、
 * サイズ・件数の上限、 ファイル名の無害化、 7 日での掃除はセッションのチャンネルと同じ決まりになる。
 *
 * @implements spec/feature/discord-notion-sync.md — 画像・添付
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamAttachmentFetcher, TeamDiscussionAttachmentView } from "../shared/team-discussion-attachments.js";
import { publicDiscordFileError, storeDiscordFiles } from "./attachment-inbox.js";
import { publicDiscordImageError, storeDiscordImages } from "./image-inbox.js";
import { splitMessageAttachments } from "./message-attachments.js";
import type { TeamAttachmentReader } from "./team-attachment-reader.js";

const INBOX_DIR_NAME = "concordia-team-discussion-attachments";

export interface TeamAttachmentFetcherDeps {
  reader: TeamAttachmentReader;
  /** 保存先の親。 未指定は OS の一時フォルダ。 */
  inboxRoot?: string;
  storeImages?: typeof storeDiscordImages;
  storeFiles?: typeof storeDiscordFiles;
  log?: { warn(message: string): void };
}

export function createTeamAttachmentFetcher(deps: TeamAttachmentFetcherDeps): TeamAttachmentFetcher {
  return {
    async fetch({ teamId, channelId, messageId }) {
      let fresh;
      try {
        fresh = await deps.reader.readAttachments(channelId, messageId);
      } catch {
        deps.log?.warn(`team discussion attachment read failed team=${teamId} message=${messageId}`);
        return { ok: false, error: "discord_api_error" };
      }
      const { images, files } = splitMessageAttachments(fresh);
      const store = { messageId, sessionId: teamId, inboxRoot: join(deps.inboxRoot ?? tmpdir(), INBOX_DIR_NAME, teamId) };
      const attachments: TeamDiscussionAttachmentView[] = [];
      try {
        const paths = images.length > 0 ? await (deps.storeImages ?? storeDiscordImages)({ ...store, attachments: images }) : [];
        paths.forEach((path, index) => {
          const image = images[index]!;
          attachments.push({ kind: "image", name: image.name ?? "", size: image.size ?? 0, path, url: image.url });
        });
      } catch (error) {
        return { ok: false, error: "store_failed", detail: publicDiscordImageError(error) };
      }
      try {
        const stored = files.length > 0 ? await (deps.storeFiles ?? storeDiscordFiles)({ ...store, attachments: files }) : [];
        stored.forEach((file, index) => {
          attachments.push({ kind: "file", name: file.name, size: file.size, path: file.path, url: files[index]!.url });
        });
      } catch (error) {
        return { ok: false, error: "store_failed", detail: publicDiscordFileError(error) };
      }
      return { ok: true, attachments };
    },
  };
}
