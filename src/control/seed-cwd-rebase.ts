/**
 * 委託テンプレートの既定 cwd を、この PC の workspace root へ読み替える。
 *
 * seed の default_cwd は本社の Ars ルート (`E:\Document\Ars\...`) で書かれている。
 * Ars ルートが違う拠点 (MELPOT = `D:\LUDIARS`) ではそのパスが実在せず、起動前の cwd 検査が
 * `spawn cwd does not exist` で全委託を止めていた (2026-10-11 MELPOT: cron 委託と
 * delegation-regression が全滅)。
 *
 * 読み替えは「本社 seed ルート配下で、かつこの PC に実在しない」ときだけ行い、
 * workspace root ごとに同じ相対パスが実在する最初の候補を返す。見つからなければ元の値を
 * そのまま返し、cwd 検査に「無い」と報告させる (黙って別の場所で起動しない)。
 */

/** seed の default_cwd が前提にしている本社の Ars ルート。 */
export const SEED_ARS_ROOT = "E:\\Document\\Ars";

export function rebaseSeedCwd(
  cwd: string,
  workspaceRoots: readonly string[],
  exists: (path: string) => boolean,
): string {
  const relative = seedRelativePath(cwd);
  if (relative === null || exists(cwd)) return cwd;
  for (const root of workspaceRoots) {
    const base = root.trim().replace(/[\\/]+$/, "");
    if (!base) continue;
    const candidate = relative ? `${base}\\${relative}` : base;
    if (exists(candidate)) return candidate;
  }
  return cwd;
}

/** seed ルート配下ならルートからの相対パス (ルート自身は "")、それ以外は null。 */
function seedRelativePath(cwd: string): string | null {
  const normalized = cwd.trim().replace(/\//g, "\\").replace(/\\+$/, "");
  const root = SEED_ARS_ROOT.toLowerCase();
  const lower = normalized.toLowerCase();
  if (lower === root) return "";
  if (!lower.startsWith(`${root}\\`)) return null;
  return normalized.slice(SEED_ARS_ROOT.length + 1);
}
