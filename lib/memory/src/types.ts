/**
 * Library Hygiene の共有型。
 *
 * 「library」= Castra / 各プロジェクトの `.claude` に蓄積したメモリ (`memory/*.md` +
 * `MEMORY.md`) と スキル (`.claude/skills/*`) の総体。 これを source(出所) ごとに
 * block(1 ファイル = 1 ルール/スキル) 単位で棚卸しする。
 */

/** block の種別。 */
export type BlockKind = "memory" | "skill";

/** source(出所) の種別。 */
export type SourceKind =
  | "central-memory" // 主ワークスペースの memory home (例 E--Document-Ars)
  | "project-memory" // その他 projects/<slug>/memory
  | "global-skill" //   <ars>/.claude/skills
  | "project-skill"; // <ars>/<repo>/.claude/skills

/** 決定的レビューが付ける block フラグ。 全て optional (true のものだけ立つ)。 */
export interface BlockFlags {
  /** MEMORY.md index に行はあるが実ファイルが無い。 */
  orphanIndex?: boolean;
  /** 実ファイルはあるが MEMORY.md index に行が無い。 */
  orphanFile?: boolean;
  /** 同一 source 内に同名 block が複数。 */
  duplicateName?: boolean;
  /** mtime が閾値より古い (陳腐化候補)。 */
  stale?: boolean;
  /** ファイルが大き過ぎる。 */
  oversize?: boolean;
  /** poison heuristics に当たった理由 (skill 中身レビュー)。 */
  poison?: string[];
}

/** 棚卸しの最小単位 = 1 メモリファイル or 1 スキル。 */
export interface LibraryBlock {
  /** React key 等の安定 id (`${sourceId}::${name}`)。 */
  id: string;
  /** 所属 source の id。 archive 操作で source を引くキー。 */
  sourceId: string;
  kind: BlockKind;
  /** ファイル basename / スキル名 (archive 操作のキー)。 */
  name: string;
  /** 表示タイトル (MEMORY.md index 見出し or frontmatter name)。 */
  title: string;
  /** 説明 (frontmatter description or MEMORY.md hook)。 */
  description: string;
  /** source root からの相対パス。 */
  relPath: string;
  size_bytes: number;
  line_count: number;
  /** epoch 秒。 */
  mtime: number;
  flags: BlockFlags;
  /** memory のみ: MEMORY.md の該当 index 行 (verbatim、 退避時に行/リンクを特定するキー)。 */
  indexLine?: string;
  /** memory のみ: この block を指すリンクの markdown 文字列 (grouped 行で 1 リンクだけ除去する用)。 */
  indexLinkText?: string;
  /** memory のみ: index 行にリンクが 1 つだけか。 false=grouped (linkText だけ除去)。 */
  indexLineSole?: boolean;
}

/** 1 つの出所 (メモリ home or スキル root)。 */
export interface LibrarySource {
  /** `mem:<slug>` / `skill:global` / `skill:<repo>` の安定 id。 */
  id: string;
  kind: BlockKind;
  sourceKind: SourceKind;
  /** 人間向けラベル。 */
  label: string;
  /** メモリ dir or スキル dir の絶対パス。 */
  rootDir: string;
  /** memory のみ: MEMORY.md の絶対パス。 */
  indexPath?: string;
  /** memory のみ: MEMORY.md の行数 / バイト数 (過多警告に使う)。 */
  indexLineCount?: number;
  indexBytes?: number;
  blocks: LibraryBlock[];
}

/** 決定的レビューの所見。 */
export interface ReviewFinding {
  level: "warn" | "info";
  /** 機械可読コード (例 "memory-index-oversize")。 */
  code: string;
  message: string;
  sourceId?: string;
  blockId?: string;
}

/** スナップショット全体。 */
export interface LibrarySnapshot {
  scannedAt: number;
  sources: LibrarySource[];
  summary: {
    totalSources: number;
    totalBlocks: number;
    totalBytes: number;
    memoryBlocks: number;
    skillBlocks: number;
  };
  /** source 横断 + source 別の所見をまとめたもの。 */
  findings: ReviewFinding[];
}

/** LLM 自動整理パスが返す 1 提案 (サジェストのみ、 自動適用しない)。 */
export interface Suggestion {
  kind: "contradiction" | "merge" | "archive" | "shorten" | "split";
  message: string;
  /** 参照する block id 群 (UI が「この退避を選択」に使う)。 */
  blockIds: string[];
  rationale?: string;
}
