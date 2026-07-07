/**
 * 決定的レビュー (純粋・LLM 不使用)。
 *
 * scanner が組んだ source/block 群に対し、 閾値判定 / orphan / 重複 / 陳腐化 を計算して
 * block.flags を埋め、 source 横断の所見 (ReviewFinding) と summary を付けた
 * LibrarySnapshot を返す。 入力 source 配列は in-place で flags が補われる
 * (リクエスト毎に scanner が新規生成する前提)。
 */
import type { LibrarySource, LibrarySnapshot } from "./types.js";
/** 閾値 (1 箇所に集約)。 */
export declare const THRESHOLDS: {
    /** MEMORY.md index の行数警告。 */
    readonly memoryIndexMaxLines: 200;
    /** MEMORY.md index のバイト数警告。 */
    readonly memoryIndexMaxBytes: 40000;
    /** index 1 行の文字数警告 (ハーネス推奨 "~200 字")。 */
    readonly indexLineMaxChars: 200;
    /** メモリ home あたりの block 数警告。 */
    readonly memoryBlocksWarn: 80;
    /** スキル root あたりの block 数警告。 */
    readonly skillBlocksWarn: 40;
    /** 1 メモリファイルのバイト数警告 (topic は小さく保つ)。 */
    readonly memoryFileMaxBytes: 16000;
    /** スキル中身のバイト数 / 行数警告。 */
    readonly skillMaxBytes: 24000;
    readonly skillMaxLines: 400;
    /** 陳腐化とみなす経過日数。 */
    readonly staleDays: 180;
};
export declare function reviewSnapshot(sources: LibrarySource[], now: number): LibrarySnapshot;
