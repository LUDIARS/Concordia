/**
 * roots を歩いて メモリ home / スキル root を発見し、 block を読み出す。
 *
 * - メモリ home: `<claudeProjectsDir>/<slug>/memory` (MEMORY.md を持つ dir)
 * - グローバルスキル: `<arsDir>/.claude/skills`
 * - プロジェクトスキル: `<arsDir>/<repo>/.claude/skills`
 *
 * 退避先 `_archive/` と隠し/アンダースコア dir は走査対象から除く。
 * flags / findings は付けない (それは review.ts の責務)。
 */
import type { LibraryRoots } from "./roots.js";
import type { LibrarySource } from "./types.js";
export declare const ARCHIVE_DIRNAME = "_archive";
/** メモリ home を発見する (MEMORY.md を持つ `<projects>/<slug>/memory`)。 */
export declare function scanMemorySources(roots: LibraryRoots): LibrarySource[];
/** スキル root を発見する (グローバル + 各リポ)。 */
export declare function scanSkillSources(roots: LibraryRoots): LibrarySource[];
/** メモリ + スキルの全 source を発見する。 */
export declare function scanLibrary(roots: LibraryRoots): LibrarySource[];
