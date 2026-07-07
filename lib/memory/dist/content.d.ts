/**
 * block / 退避ファイルの中身読み出し (path-traversal 安全)。
 *
 * - live: source rootDir 配下の relPath
 * - archived: source rootDir/_archive 配下の relPath (台帳の archivedAs)
 * dir-skill は中の SKILL.md を読む。 `src/session-logs/reader.ts` の包含チェックに倣う。
 */
export interface BlockContent {
    path: string;
    content: string;
    truncated: boolean;
    size_bytes: number;
}
export declare function readBlockContent(rootDir: string, relPath: string, archived: boolean): BlockContent | null;
