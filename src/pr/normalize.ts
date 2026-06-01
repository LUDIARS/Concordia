/**
 * PR キューの入力正規化ヘルパ.
 *
 * stat payload の open_prs[] は AI が自由に吐くため repo 表記が揺れる
 * (owner/repo / GitHub URL / SSH / ローカルパス). reconcile (gh) は owner/repo を
 * 要求するので、 可能な限り `owner/repo` に正規化する.
 */

/** owner/repo 形式かどうか (gh --repo に渡せる形). */
export function isOwnerRepo(s: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(s);
}

/**
 * 各種 repo 表記を `owner/repo` に正規化する. 解釈できなければ trim した原文を返す.
 *  - https://github.com/Owner/Repo(.git) → Owner/Repo
 *  - git@github.com:Owner/Repo.git        → Owner/Repo
 *  - Owner/Repo                            → そのまま
 *  - C:/path/to/Repo                       → 解釈不能なので原文
 */
export function normalizeRepoOrigin(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return s;
  // git@host:owner/repo.git
  const ssh = s.match(/^[\w.-]+@[\w.-]+:([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (ssh) return ssh[1];
  // https://host/owner/repo(.git)
  const https = s.match(/^https?:\/\/[\w.-]+\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  if (https) return https[1];
  if (isOwnerRepo(s)) return s;
  return s;
}

/** owner/repo + number から GitHub PR URL を組む (owner/repo でなければ null). */
export function prUrlFor(repoOrigin: string, number: number): string | null {
  return isOwnerRepo(repoOrigin) ? `https://github.com/${repoOrigin}/pull/${number}` : null;
}

export interface ParsedOpenPr {
  repo_origin: string;
  number: number;
  title?: string;
  head_branch?: string | null;
  url?: string | null;
}

/**
 * stat payload から open_prs[] を抽出して正規化する.
 * 期待形: { open_prs: [{ repo, number, title?, branch? , url? }] }
 * 壊れたエントリ (number 無し / repo 無し) は捨てる.
 */
export function parseOpenPrsFromStat(payload: unknown): ParsedOpenPr[] {
  if (!payload || typeof payload !== "object") return [];
  const arr = (payload as { open_prs?: unknown }).open_prs;
  if (!Array.isArray(arr)) return [];
  const out: ParsedOpenPr[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const number = typeof o.number === "number" ? o.number : Number(o.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    const repoRaw =
      typeof o.repo === "string"
        ? o.repo
        : typeof o.repo_origin === "string"
          ? o.repo_origin
          : "";
    const repo_origin = normalizeRepoOrigin(repoRaw);
    if (!repo_origin) continue;
    const urlRaw = typeof o.url === "string" ? o.url : null;
    out.push({
      repo_origin,
      number,
      title: typeof o.title === "string" ? o.title : undefined,
      head_branch:
        typeof o.branch === "string"
          ? o.branch
          : typeof o.head_branch === "string"
            ? o.head_branch
            : null,
      url: urlRaw ?? prUrlFor(repo_origin, number),
    });
  }
  return out;
}
