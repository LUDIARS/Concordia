/**
 * 相談部屋に添付されたファイルの置き場所と、 相談セッションがそれを開いてよいかの判定
 * (spec/feature/tech-consultation.md §6.5、 CC-CONSULT-INV-12、 2026-10-23 neco 指示「添付は全部見れるはずだから見れるようにしてほしい」)。
 *
 * 置き場所は相談者ごと (`<一時フォルダ>/concordia-consult-attachments/<相談者の Discord ID>`)。 相談フォルダ
 * (役職フォルダ・データフォルダ) の外に置き、 相談セッションに開くのを許すのはこのフォルダの中だけ。
 * - claude: 起動ごとに `--allowedTools Read(<フォルダ>/**)` を渡す (役職フォルダの設定は同じ役職の相談で共有なので、
 *   相談者ごとの許可は起動引数で持つ)。 相談フォルダ全体の Read は役職フォルダの設定で拒否する。
 * - codex (Astra): 画像は view_image で開く。 Cc のハーネス判定 (safety-policy.ts) がこのフォルダの中だけを通す。
 *
 * 業務判断だけを持つ純関数。
 *
 * @implements SPEC-CONSULT-ATTACHMENTS
 */

import { join } from "node:path";

/** 起動 env に入れる添付の置き場所 (codex のフック・案内用)。 */
export const CONSULT_ATTACHMENT_DIR_ENV = "CONCORDIA_CONSULT_ATTACHMENT_DIR";

const ATTACHMENT_ROOT_NAME = "concordia-consult-attachments";

/** 相談者の添付の置き場所。 Discord の個人 ID (数字) が無ければ null (添付を受け取る相談ではない)。 */
export function consultAttachmentDir(tempRoot: string, requesterDiscordUserId: string | null | undefined): string | null {
  const id = requesterDiscordUserId?.trim() ?? "";
  return /^\d{5,32}$/.test(id) ? join(tempRoot, ATTACHMENT_ROOT_NAME, id) : null;
}

/** セッションの metadata (JSON) から相談者の Discord の個人 ID を読む。 読めなければ null。 */
export function requesterFromSessionMetadata(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  try {
    const value = (JSON.parse(metadata) as Record<string, unknown> | null)?.discord_requester_user_id;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * そのパスが添付の置き場所の中のファイルか。 `..`・別ドライブ・置き場所そのものは通さない。
 * Windows のパスは大文字小文字を区別しない。
 */
export function isConsultAttachmentPath(path: string | null | undefined, attachmentDir: string | null | undefined): boolean {
  if (!path || !attachmentDir) return false;
  const target = normalize(path.trim());
  if (target.split("/").some((part) => part === "..")) return false;
  const base = normalize(attachmentDir);
  const windows = /^[a-z]:\//i.test(base);
  const fold = (value: string) => (windows ? value.toLowerCase() : value);
  return fold(target).startsWith(`${fold(base)}/`) && target.length > base.length + 1;
}

/**
 * Claude Code の権限規則に書く絶対パス (`//` から始める)。 Windows のパスは POSIX の形 (`C:\a` → `/c/a`) に直してから
 * 照合されるので、 その形で書く。
 */
export function claudeAbsolutePathRule(path: string): string {
  const slashed = normalize(path);
  const drive = slashed.match(/^([a-z]):\/(.*)$/i);
  return drive ? `//${drive[1].toLowerCase()}/${drive[2]}` : `/${slashed.startsWith("/") ? slashed : `/${slashed}`}`;
}

/** 相談セッションの claude に渡す、 添付の置き場所の Read だけを許す起動引数。 置き場所が無ければ空。 */
export function consultAttachmentClaudeArgs(attachmentDir: string | null): readonly string[] {
  if (!attachmentDir) return [];
  return ["--allowedTools", `Read(${claudeAbsolutePathRule(attachmentDir)}/**)`];
}

/** 相談フォルダ全体の Read を拒否する規則 (役職フォルダの設定に書く)。 cwd の中の読み取りも止める。 */
export function consultWorkspaceReadDenyRule(consultRoot: string): string {
  return `Read(${claudeAbsolutePathRule(consultRoot)}/**)`;
}
