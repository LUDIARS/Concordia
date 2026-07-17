/**
 * kind 別 Inject マニュアルの既定 seed。 boot 時に冪等に投入する (neco 指示 2026-07-17)。
 * harness-seed.ts と同パターン: 既存行があれば content を上書きしない (ユーザ編集尊重)。
 * 内容の調整は WebUI (/manuals) から行う。
 */

import type { InjectManualsRepo, InjectManualKind } from "../db/inject-manuals-repo.js";

const DEFAULT_MANUALS: Record<InjectManualKind, string> = {
  実装:
    "作業ブランチを確定 → worktree を生成 → 作業 → task md (spec/tasks/) に分解 → コミット → PR 作成まで行う。" +
    "main/develop へ直コミットしない。オートマージ禁止。レビューとテストは PR 作成後に非同期でよい。",
  レビュー:
    "worktree の生成・ブランチ切り替えは不要。main 最新、または指定されたブランチ/worktree の上で読む。" +
    "コードの修正・git 操作はしない。指摘は重大度 + file:line。成果は Review/ フォルダまたはレポートで返す。",
  設計相談:
    "worktree は不要。読み取り中心で分析し、spec の編集を伴う場合のみブランチ → PR。" +
    "結論はトレードオフ比較つきで spec/plan/ 形式に。",
  テスト:
    "テストワークフロー (confirm キュー) に従う。セッション内・worktree でのサービス起動・動作テストは行わない。",
  雑用: "軽作業。リポ変更を伴うならブランチ → PR、読み取りのみなら自由。",
};

export function seedInjectManuals(repo: InjectManualsRepo, now = Date.now()): void {
  for (const [kind, content] of Object.entries(DEFAULT_MANUALS)) {
    repo.ensureDefault(kind, content, now);
  }
}
