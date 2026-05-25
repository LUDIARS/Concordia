/**
 * LUDIARS リポジトリの 2 文字コード lookup.
 *
 * 正本: E:/Document/Ars/LUDIARS/PROJECT-CODES.md と
 *       E:/Document/Ars/.claude/lib/project-code.sh.
 * Web UI のみで使う static map. 新 repo を追加するときは 3 箇所同期する.
 */

const CODES: Record<string, string> = {
  LUDIARS: "L",
  infra: "In",
  AIFormat: "Af",
  "All-In-OneTest": "Ao",
  Ars: "Ar",
  Ergo: "Eg",
  Pictor: "Pc",
  Cernere: "Cr",
  Nuntius: "Nt",
  Actio: "At",
  "Actio-PublicModules": "Ap",
  "Actio-SchoolModules": "As",
  Calicula: "Ca",
  Discutere: "Di",
  AdventureCube: "AC",
  Synergos: "Sy",
  Tessera: "Te",
  Codex: "Cx",
  Curare: "Cu",
  Clio: "Cl",
  Signum: "Si",
  Imperativus: "Iv",
  Iter: "It",
  Memoria: "Mm",
  Custos: "Cs",
  Susurrus: "Su",
  Bibliotheca: "Bb",
  Conciliator: "Cn",
  Praeforma: "Pf",
  Tirocinium: "Tr",
  "Ars-Module": "Am",
  "Ars-Musa": "Au",
  "Ars-PlatformPlugin": "Ax",
  // PROJECT-CODES.md 未登録だがメモリ運用
  Concordia: "Co",
  Schedula: "Sc",
  Aedilis: "Ae",
  Hora: "Ho",
  KuzuSurvivors: "KS",
  Legatus: "Le",
  Lector: "Lc",
  Ludellus: "Ll",
  Quaestor: "Qu",
  Excubitor: "Ex",
  "Calicula-Desktop": "Ca",
  Lictor: "Li",
  VantanHub: "Vh",
};

/**
 * repo path (絶対 / 相対どちらでも) から 2 文字コードを返す.
 * basename 一致を試み、 マッチしなければ null.
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
