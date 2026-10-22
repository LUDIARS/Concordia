/**
 * src/discord/attachment-files.ts — ローカル絶対パス → Discord の files。
 *
 * 許可ルート検査・サイズ検査・読み込みは src/shared/attachment-files.ts (Slack と共通の 1 本)。
 * ここは Discord の上限と、 テキスト添付を展開できる名前への付け替えだけを持つ。
 *
 * @implements spec/feature/discord-ui.md — attachment_paths
 */

import { readAttachmentFiles } from "../shared/attachment-files.js";
import { discordTextAttachmentName } from "./text-attachment.js";

/** Discord の 25 MiB 上限に対する安全側の閾値。 */
export const DISCORD_ATTACH_MAX_BYTES = 24 * 1024 * 1024;

export interface DiscordAttachFile {
  attachment: Buffer;
  name: string;
}

/**
 * 許可ルート内のファイルだけを読み、 Discord に載せられる形にする。
 * 弾いた・読めなかったものは warn に理由を残して飛ばす (投稿自体は落とさない)。
 */
export async function buildAttachFiles(
  rawPaths: readonly string[] | undefined,
  label: string,
  log: { warn: (m: string) => void },
  workspaceRoots: string[],
): Promise<DiscordAttachFile[]> {
  const files = await readAttachmentFiles(rawPaths, { label, log, workspaceRoots, maxBytes: DISCORD_ATTACH_MAX_BYTES });
  return files.map((file) => ({ attachment: file.data, name: discordTextAttachmentName(file.name, file.data) }));
}
