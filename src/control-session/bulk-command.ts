/**
 * 管制チャンネルの投稿が一括指示かを読み取る純関数。
 * `一括: …` / `一括指示: …` / `一括[Cc,At]: …` (プロジェクトコードで対象を絞る)。
 *
 * @implements spec/feature/control-session.md — 3. 管制チャンネルと側セッション
 */

export interface BulkCommand {
  /** 対象のプロジェクトコード。空なら全 active。 */
  projectCodes: string[];
  text: string;
}

const BULK_PATTERN = /^\s*一括(?:指示)?\s*(?:[[［]([^\]］]*)[\]］])?\s*[:：]\s*([\s\S]+)$/;

export function parseBulkCommand(content: string): BulkCommand | null {
  const match = BULK_PATTERN.exec(content);
  if (!match) return null;
  const text = match[2].trim();
  if (!text) return null;
  const projectCodes = (match[1] ?? "")
    .split(/[,、\s]+/)
    .map((code) => code.trim())
    .filter(Boolean);
  return { projectCodes: [...new Set(projectCodes)], text };
}
