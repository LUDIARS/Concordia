/**
 * Excubitor の service.deployed が名乗る `code` は Excubitor catalog のサービスコード
 * (`concordia` / `revisor` / `memoria-server` …) で、 Cc の project code (`Cc` / `Rv`) ではない。
 * project registry の行は、 code の完全一致 → project 名の大文字小文字無視一致 →
 * repo_origin 末尾 (owner/name の name) の大文字小文字無視一致、 の順で引く。
 * `memoria-server` のような component 付きコードは `-` 以降を落とした基底名でも試す。
 */
export interface ProjectRowLike {
  code: string;
  project: string;
  repo_origin: string | null;
}

function repoName(origin: string | null): string | null {
  if (!origin) return null;
  const tail = origin.replace(/\.git$/i, "").replace(/\/+$/, "").split(/[/:]/).pop();
  return tail ? tail.toLowerCase() : null;
}

export function matchProjectRow<T extends ProjectRowLike>(rows: readonly T[], serviceCode: string): T | null {
  const code = serviceCode.trim();
  if (!code) return null;
  const exact = rows.find((row) => row.code === code);
  if (exact) return exact;
  const candidates = [code.toLowerCase()];
  const base = code.toLowerCase().split("-")[0];
  if (base && base !== candidates[0]) candidates.push(base);
  for (const candidate of candidates) {
    const byProject = rows.find((row) => row.project.toLowerCase() === candidate);
    if (byProject) return byProject;
    const byOrigin = rows.find((row) => repoName(row.repo_origin) === candidate);
    if (byOrigin) return byOrigin;
  }
  return null;
}
