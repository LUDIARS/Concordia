/**
 * 走査 roots の解決 (fail-fast)。
 *
 * - arsDir: LUDIARS 全リポと グローバルスキル `.claude/skills` を含む親
 *   (既定はプライマリ workspace root、 env `CONCORDIA_ARS_DIR` で上書き)。
 * - claudeProjectsDir: `~/.claude/projects` (メモリ home 群の親、
 *   env `CONCORDIA_CLAUDE_PROJECTS_DIR` で上書き)。
 * - centralSlug: 主ワークスペースのメモリ home slug (env `CONCORDIA_CENTRAL_MEMORY_SLUG`)。
 *
 * 必須前提 (両 base dir のどちらかは実在) が満たせなければ silent に空で返さず
 * 例外を投げる (規約 §6/§7.1 fail-fast)。
 */
export interface LibraryRoots {
    arsDir: string;
    claudeProjectsDir: string;
    centralSlug: string;
}
export declare class LibraryRootsError extends Error {
    constructor(message: string);
}
export declare function resolveLibraryRoots(workspaceRoots: string[]): LibraryRoots;
