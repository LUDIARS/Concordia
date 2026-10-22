/**
 * src/slack/chat-attachments.ts — chat の `attachment_paths` を Slack のファイルとして上げる。
 *
 * 本文は bot が postMessage で先に出し、 添付はその直後に同じチャンネルへ filesUploadV2 で上げる
 * (Discord egress が本文と files を 1 投稿にするのと同じ内容が Slack にも届く)。
 * ファイルの許可ルート検査・サイズ検査・読み込みは src/shared/attachment-files.ts (Discord と共通)。
 *
 * SRP: 読めた添付のアップロードだけ。 失敗は warn に残し、 投稿全体は落とさない。
 *
 * @implements spec/feature/slack-platform.md — 添付ファイル
 */

import { readAttachmentFiles } from "../shared/attachment-files.js";

/** 1 ファイルの上限 (Slack 自体は 1 GB まで受けるが、 メモリに読み込むので抑える)。 */
export const SLACK_ATTACH_MAX_BYTES = 100 * 1024 * 1024;

/** filesUploadV2 の使う形だけ (テストで差し替える)。 */
export interface SlackFileUploadClient {
  filesUploadV2(args: {
    channel_id: string;
    thread_ts?: string;
    file_uploads: Array<{ file: Buffer; filename: string }>;
  }): Promise<unknown>;
}

export interface SlackAttachmentInput {
  channelId: string;
  /** スレッドに付けるとき (セッションのトップレベル投稿なら省く)。 */
  threadTs?: string;
  paths: readonly string[] | undefined;
  /** ログの識別 (message id 等)。 */
  label: string;
  workspaceRoots: string[];
}

/** 添付を上げ、 上げた件数を返す (無い・全部弾いた・失敗は 0)。 */
export async function uploadSlackAttachments(
  client: SlackFileUploadClient,
  input: SlackAttachmentInput,
  log: { warn: (m: string) => void; info: (m: string) => void },
): Promise<number> {
  const files = await readAttachmentFiles(input.paths, {
    label: input.label,
    log,
    workspaceRoots: input.workspaceRoots,
    maxBytes: SLACK_ATTACH_MAX_BYTES,
  });
  if (files.length === 0) return 0;
  try {
    await client.filesUploadV2({
      channel_id: input.channelId,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      file_uploads: files.map((file) => ({ file: file.data, filename: file.name })),
    });
    log.info(`[verbose-slack-egress] attachments uploaded ${input.label} channel=${input.channelId} count=${files.length}`);
    return files.length;
  } catch (e) {
    log.warn(`filesUploadV2 failed ${input.label} channel=${input.channelId}: ${(e as Error).message}`);
    return 0;
  }
}
