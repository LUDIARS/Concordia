/**
 * session-log 本文から「どのプロジェクトの作業か」を機械抽出するための照合辞書。
 *
 * 正本は CLAUDE.md / `LUDIARS/PROJECT-CODES.md`。 ここはそのコピーではなく、
 * session-log (`E:/Document/Ars/session-logs/<date>.md`) を per-project に分類する
 * ためだけの照合用リスト。 session-log は見出し・本文ともプロジェクト「正式名」で
 * 書かれる慣習なので、 略称コード (KS / Tr 等) は誤検出 (英文中の "An" 等) を避けて
 * 採用しない。 正式名のみを語境界付きで照合する。
 *
 * 除外: `Ars` / `LUDIARS` / `infra` はパス (`E:/Document/Ars/...`) に遍在し全 log に
 * マッチしてしまうため、 プロジェクトタグの語彙からは外す。
 */
export const PROJECT_NAMES: readonly string[] = [
  // メタ / インフラ
  "AIFormat", "All-In-OneTest",
  // コアエンジン / SDK
  "Ergo", "Pictor", "Lapilli", "Vestigium", "Canalis", "Lector", "Fundamentum", "UnityFoundation",
  // 認証 / 通知
  "Cernere", "Nuntius", "Ostiarius",
  // スケジュール / タスク (長い名前を先に置く)
  "Actio-PublicModules", "Actio-SchoolModules", "Actio", "Schedula", "Calicula", "Aedilis", "Discutere",
  // ゲーム
  "AdventureCube", "KuzuSurvivors", "UniLand", "Ludus",
  // ネットワーク
  "Synergos", "Tessera", "Codex", "VTN-Connect",
  // アセット / ツール
  "Curare", "Clio", "Signum", "Imperativus", "Iter", "Memoria", "Custos", "Susurrus", "Bibliotheca",
  "Quaestor", "Conciliator", "Praeforma", "Tirocinium", "Lictor", "Hora", "Ludellus-Server", "Ludellus",
  // Hub / 運用協調
  "Concordia", "Corpus", "Excubitor", "Famulus", "Legatus", "VantanHub",
  // Ars プラグイン
  "Ars-Module", "Ars-Musa", "Ars-PlatformPlugin",
  // 新規リポ (memory 由来、 PROJECT-CODES 未収載のものを含む)
  "Anatomia", "GLAB",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * テキスト中に登場するプロジェクト正式名を抽出する。
 *
 * 判定: 名前が 1 回でも出れば「そのログの対象プロジェクト」とみなす。 用途は
 * 「過去作業を引き継ぐために該当プロジェクトのログを見つける」ことなので、
 * 取りこぼし (recall) を多少の過剰タグ (precision) より優先する。 パスに遍在して
 * 全 log を汚す Ars / LUDIARS / infra は語彙から除外済み (上記 PROJECT_NAMES)。
 *
 * 語境界は ASCII 単語文字 / ハイフンの不在で判定する (`\w` は ASCII なので、
 * 日本語が直後に続く "Anatomia残タスク" でもマッチする)。 これにより "Actio" は
 * "Actio-PublicModules" の内側にはマッチせず (直後が `-`)、 親子の二重タグを避ける。
 */
export function extractProjects(text: string): string[] {
  const found: string[] = [];
  for (const name of PROJECT_NAMES) {
    const re = new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`);
    if (re.test(text)) found.push(name);
  }
  return found;
}
