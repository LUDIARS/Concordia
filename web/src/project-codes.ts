/**
 * LUDIARS リポジトリの 2 文字コード lookup.
 *
 * 正本: LUDIARS/PROJECT-CODES.md
 * 同期先: E:/Document/Ars/CLAUDE.md / ~/.claude/skills/project-codes/SKILL.md
 * Web UI のみで使う static map. 新 repo を追加するときは同期先も更新する.
 */

export interface ProjectCategory {
  name: string;
  entries: [string, string][]; // [code, repoName]
}

export const PROJECT_CATEGORIES: ProjectCategory[] = [
  {
    name: "メタ / インフラ",
    entries: [
      ["L/Ld", "LUDIARS"],
      ["In", "infra"],
      ["Af", "AIFormat"],
      ["Ao", "All-In-OneTest"],
    ],
  },
  {
    name: "コアエンジン / SDK",
    entries: [
      ["Ar", "Ars"],
      ["Eg", "Ergo"],
      ["Pc", "Pictor"],
      ["Lp", "Lapilli"],
      ["Vg", "Vestigium"],
      ["Ci", "Canalis"],
      ["Lc", "Lector"],
    ],
  },
  {
    name: "認証 / 通知",
    entries: [
      ["Cr", "Cernere"],
      ["Nt", "Nuntius"],
      ["Os", "Ostiarius"],
    ],
  },
  {
    name: "スケジュール / タスク",
    entries: [
      ["At/A", "Actio"],
      ["Sc", "Schedula"],
      ["Ap", "Actio-PublicModules"],
      ["As", "Actio-SchoolModules"],
      ["Ca", "Calicula"],
      ["Ae", "Aedilis"],
      ["Di", "Discutere"],
    ],
  },
  {
    name: "ゲーム",
    entries: [
      ["AC", "AdventureCube"],
      ["KS", "KuzuSurvivors"],
      ["Ul", "UniLand"],
      ["Lu", "Ludus"],
    ],
  },
  {
    name: "ネットワーク",
    entries: [
      ["Sy", "Synergos"],
      ["Te", "Tessera"],
      ["Cx", "Codex"],
      ["Vc", "VTN-Connect"],
    ],
  },
  {
    name: "アセット / ツール",
    entries: [
      ["Cu", "Curare"],
      ["Cl", "Clio"],
      ["Si", "Signum"],
      ["Iv", "Imperativus"],
      ["It", "Iter"],
      ["Mm", "Memoria"],
      ["Cs", "Custos"],
      ["Su", "Susurrus"],
      ["Bb", "Bibliotheca"],
      ["Qu", "Quaestor"],
      ["Cn", "Conciliator"],
      ["Pf", "Praeforma"],
      ["Tr", "Tirocinium"],
      ["Li", "Lictor"],
      ["Hr", "Hora"],
      ["Ll", "Ludellus-Server"],
    ],
  },
  {
    name: "Hub / 運用協調",
    entries: [
      ["Cc", "Concordia"],
      ["Co", "Corpus"],
      ["Ex", "Excubitor"],
      ["Fa", "Famulus"],
      ["Lg", "Legatus"],
      ["Vh", "VantanHub"],
    ],
  },
  {
    name: "Ars プラグイン",
    entries: [
      ["Am", "Ars-Module"],
      ["Au", "Ars-Musa"],
      ["Ax", "Ars-PlatformPlugin"],
    ],
  },
];

// Flat lookup: repoBasename → code (後方互換で維持)
const CODES: Record<string, string> = Object.fromEntries(
  PROJECT_CATEGORIES.flatMap((cat) =>
    cat.entries.map(([code, repo]) => [repo, code.split("/")[0]]),
  ),
);

/**
 * repo path (絶対 / 相対どちらでも) から 2 文字コードを返す.
 * basename 一致を試み、マッチしなければ null.
 */
export function projectCodeFor(repoPath: string | null | undefined): string | null {
  if (!repoPath) return null;
  const parts = repoPath.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return null;
  const base = parts[parts.length - 1];
  return CODES[base] ?? null;
}

export function repoBasename(repoPath: string | null | undefined): string {
  if (!repoPath) return "";
  const parts = repoPath.split(/[\\/]/).filter(Boolean);
  return parts.length === 0 ? "" : parts[parts.length - 1];
}
