/**
 * 添付ファイルのパス許可ポリシー設定 (`CONCORDIA_ATTACHMENT_ENFORCE` / `_ROOTS`)。
 *
 * chat API の受信側 (api/chat.ts) と Discord への送出側 (discord/egress.ts) が
 * 同じ 2 キーを個別に読んでいた。 入口と出口で許可ルートが食い違うと
 * 「受け付けたのに送れない / 受け付けていないのに送れる」 という境界の破れになるため、
 * 両者が同じ設定を見ることをこのモジュールで保証する。
 *
 * 既定は enforce ON。 `"0"` のときだけ audit のみ (拒否理由は記録するが遮断しない)。
 */

import { readFlagDefaultOn } from "./env-parse.js";

/** 許可外パスを実際に遮断するか。 false なら audit のみ。 */
export function isAttachmentEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return readFlagDefaultOn(env.CONCORDIA_ATTACHMENT_ENFORCE);
}

/**
 * ワークスペースルート / temp に追加する許可ルートの生の env 値。
 * 分解は `shared/attachment-paths.ts` の `buildAttachmentRoots` が行う。
 */
export function configuredAttachmentRoots(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CONCORDIA_ATTACHMENT_ROOTS;
}
