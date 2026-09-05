/**
 * src/discord/attachment-files.ts — ローカル絶対パス → Discord の files。
 *
 * egress の `attachment_paths` 処理から切り出したもの。 添付を出す口が増えるたびに
 * 許可ルート検査を書き直すと、 いつか **検査の無い口**ができる。 経路は 1 本に保つ。
 *
 * SRP: 許可ルート検査 + サイズ検査 + 読み込み。 送信先は呼び出し側。
 *
 * @implements spec/feature/discord-ui.md — attachment_paths
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAttachmentRoots, createAttachmentGuard } from "../shared/attachment-paths.js";
import { configuredAttachmentRoots, isAttachmentEnforced } from "../config/attachment-policy.js";

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
  if (!rawPaths?.length) return [];
  const enforce = isAttachmentEnforced();
  const guard = createAttachmentGuard({
    roots: buildAttachmentRoots({
      workspaceRoots,
      tempDir: os.tmpdir(),
      configuredRoots: configuredAttachmentRoots(),
    }),
    enforce,
  });
  const out: DiscordAttachFile[] = [];
  for (const p of rawPaths) {
    const result = await guard.check(p);
    if (!result.ok) {
      log.warn(`egress: attachment rejected ${label} reason=${result.reason} path=${p}`);
      if (enforce) continue;
    }
    const absPath = result.ok ? result.realPath : p;
    if (!path.isAbsolute(absPath)) {
      log.warn(`egress: attachment skipped (not absolute) ${label} path=${p}`);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absPath);
    } catch {
      log.warn(`egress: attachment not found ${label} path=${absPath}`);
      continue;
    }
    if (stat.size > DISCORD_ATTACH_MAX_BYTES) {
      log.warn(`egress: attachment too large (${stat.size}B) ${label} path=${absPath}`);
      continue;
    }
    try {
      out.push({ attachment: await fs.promises.readFile(absPath), name: path.basename(absPath) });
    } catch (err) {
      log.warn(`egress: attachment read failed ${label} path=${absPath}: ${(err as Error).message}`);
    }
  }
  return out;
}
