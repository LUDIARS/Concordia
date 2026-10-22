/**
 * src/shared/attachment-files.ts — chat の `attachment_paths` (ローカル絶対パス) を読む唯一の口。
 *
 * Discord egress と Slack bot の両方がここを通る。 添付を出す口が増えるたびに
 * 許可ルート検査を書き直すと、 いつか **検査の無い口**ができる。 経路は 1 本に保つ。
 *
 * SRP: 許可ルート検査 + サイズ検査 + 読み込み。 名前の付け替えと送信先は呼び出し側。
 *
 * @implements spec/feature/discord-ui.md — attachment_paths
 * @implements spec/feature/slack-platform.md — 添付ファイル
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAttachmentRoots, createAttachmentGuard } from "./attachment-paths.js";
import { configuredAttachmentRoots, isAttachmentEnforced } from "../config/attachment-policy.js";

export interface AttachmentFile {
  data: Buffer;
  /** 元ファイルの basename。 */
  name: string;
}

export interface ReadAttachmentOptions {
  /** ログに出す識別 (message id 等)。 */
  label: string;
  log: { warn: (m: string) => void };
  workspaceRoots: string[];
  /** 送り先の上限。 超えるものは飛ばす。 */
  maxBytes: number;
}

/**
 * 許可ルート内のファイルだけを読む。
 * 弾いた・読めなかったものは warn に理由を残して飛ばす (投稿自体は落とさない)。
 */
export async function readAttachmentFiles(
  rawPaths: readonly string[] | undefined,
  options: ReadAttachmentOptions,
): Promise<AttachmentFile[]> {
  if (!rawPaths?.length) return [];
  const { label, log, maxBytes } = options;
  const enforce = isAttachmentEnforced();
  const guard = createAttachmentGuard({
    roots: buildAttachmentRoots({
      workspaceRoots: options.workspaceRoots,
      tempDir: os.tmpdir(),
      configuredRoots: configuredAttachmentRoots(),
    }),
    enforce,
  });
  const out: AttachmentFile[] = [];
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
    if (stat.size > maxBytes) {
      log.warn(`egress: attachment too large (${stat.size}B) ${label} path=${absPath}`);
      continue;
    }
    try {
      out.push({ data: await fs.promises.readFile(absPath), name: path.basename(absPath) });
    } catch (err) {
      log.warn(`egress: attachment read failed ${label} path=${absPath}: ${(err as Error).message}`);
    }
  }
  return out;
}
