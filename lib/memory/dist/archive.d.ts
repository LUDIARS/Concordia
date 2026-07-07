/**
 * 退避 (archive) と復帰 (restore) の副作用層。
 *
 * 完全削除は **しない** (規約 req 6)。 block のファイルを兄弟 `_archive/` へ move し、
 * メモリなら MEMORY.md から該当 index 行を改行コードを保ったまま除去、 `_archive/ledger.jsonl`
 * (機械) と `_archive/ARCHIVE.md` (人間) に追記する。 退避ファイルは人間が読める
 * (= オールドファッションルールとして保存) が、 index / 自動ロード対象からは外れる。
 *
 * - planArchive: dry-run (fs 書き込みなし)。
 * - applyArchive: 実行。
 * - listArchived / restore: 台帳閲覧と復帰。
 *
 * `now` (epoch 秒) は注入式 (テスト決定性、 規約 §16)。
 */
import type { BlockKind } from "./types.js";
/** 退避対象 (API が snapshot から組み立てて渡す)。 */
export interface ArchiveTarget {
    blockId: string;
    name: string;
    kind: BlockKind;
    /** ファイル/ディレクトリの絶対パス。 orphan-index では存在しないことがある。 */
    absPath: string;
    /** 退避先 `_archive/` dir の絶対パス。 */
    archiveDir: string;
    /** source root からの相対パス (復帰時の戻し先)。 */
    relPath: string;
    /** memory のみ: MEMORY.md 絶対パス。 */
    indexPath?: string;
    /** memory のみ: 除去する index 行 (verbatim、 終端改行は含まない)。 */
    indexLine?: string;
    /** memory のみ: この block を指すリンクの markdown 文字列。 grouped 行 (indexLineSole=false) で 1 リンクだけ除去する用。 */
    indexLinkText?: string;
    /** memory のみ: index 行にリンクが 1 つだけか。 false=grouped (linkText だけ除去し行は残す)。 */
    indexLineSole?: boolean;
    /** ファイル移動なしで index 行だけ消す (orphan-index)。 */
    orphanIndex?: boolean;
    /** 退避理由 (台帳に残す)。 */
    reason?: string;
}
export interface ArchivePlanItem {
    blockId: string;
    name: string;
    action: "move-and-deindex" | "deindex-only" | "move";
    from: string | null;
    to: string | null;
    indexLineRemoved: boolean;
    warnings: string[];
    ok: boolean;
}
export interface ArchiveResult {
    applied: boolean;
    items: ArchivePlanItem[];
}
interface LedgerRecord {
    ts: number;
    blockId: string;
    name: string;
    kind: BlockKind;
    /** source root からの相対パス (復帰先)。 */
    relPath: string;
    /** `_archive/` 内の basename (move した先の名前)。 null = ファイル移動なし。 */
    archivedAs: string | null;
    /** memory のみ: 除去した index 行 (復帰で再追記)。 */
    indexLine?: string;
    reason?: string;
}
/** dry-run: 何が起きるかを計算する (fs は変更しない)。 */
export declare function planArchive(targets: ArchiveTarget[]): ArchivePlanItem[];
/** 実行: move + de-index + 台帳追記。 dry-run で ok=false の item は skip する。 */
export declare function applyArchive(targets: ArchiveTarget[], now: number): ArchiveResult;
/** 台帳 (ledger.jsonl) を読み、 現在退避中のエントリを新しい順で返す。 */
export declare function listArchived(archiveDir: string): LedgerRecord[];
export interface RestoreResult {
    ok: boolean;
    name: string;
    restoredTo: string | null;
    indexLineRestored: boolean;
    warnings: string[];
}
/** 退避を戻す。 archiveDir 配下の name に対応する台帳を引き、 ファイルを元位置へ move、
 *  memory なら index 行を MEMORY.md 末尾に再追記する。 */
export declare function restoreArchived(archiveDir: string, blockId: string, now: number): RestoreResult;
/**
 * MEMORY.md から indexLine (trim 一致) の物理行を 1 つ除去する。
 * 他行の改行コードは保つ (req: 改行コードを保ったまま)。
 */
export declare function removeIndexLine(raw: string, indexLine: string): {
    content: string;
    removed: boolean;
};
/**
 * grouped 行 (1 行に複数リンク) から該当リンク `[title](file.md)` 1 つだけを除去する。
 * 該当物理行を indexLine(trim 一致) で特定し、 linkText + 隣接セパレータ (" / " か "/")
 * を 1 つ削る。 除去後にその行へリンクが残らなければ行ごと消す。 他行の改行コードは保つ。
 * 注: リンク直後の括弧注記 (例 "(正本RULE§7)") は残置する (まれな大原則行のみ該当)。
 */
export declare function removeIndexLink(raw: string, lineRaw: string, linkText: string): {
    content: string;
    removed: boolean;
};
/** archiveDir 配下の退避済みファイル名一覧 (台帳と突合せず生の中身を見る用)。 */
export declare function listArchiveFiles(archiveDir: string): string[];
export {};
