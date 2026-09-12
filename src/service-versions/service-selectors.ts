/**
 * 「どのサービスの版を聞くのか」を決める。
 *
 * 呼び出し側が使う名前は 3 通りある — LUDIARS のプロジェクトコード (`Rv`)、 プロジェクト名
 * (`Revisor`)、 Excubitor のサービス code (`concordia-cost`)。 Revisor は catalog の code /
 * repo / project_code を解決できるが、 LUDIARS のプロジェクトコードだけは catalog に
 * 載っていないことがある (正本は Cc の project_codes)。 だから **Cc が知っている略称だけ
 * をここで実名へ開き**、 残りは触らず Revisor へ渡す。 両方で同じ解決を持つと、 片方を
 * 直したときにもう片方が古い対応表のまま残る。
 *
 * @implements spec/feature/project-code-registry.md — 略称の正本は Cc
 */

export interface ProjectCodeLookup {
  list(): ReadonlyArray<{ code: string; project: string; repo_path: string; repo_origin: string | null }>;
  findByCode(code: string): { project: string } | null;
  findByRepoOrigin(repoOrigin: string): { project: string } | null;
}

export interface RepoContext {
  repoPath: string;
  repoOrigin: string | null;
}

export class UnknownProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownProjectError";
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 略称なら実名へ開く。 それ以外は Revisor 側の解決に委ねてそのまま通す。 */
export function expandSelector(projectCodes: ProjectCodeLookup, selector: string): string {
  const trimmed = selector.trim();
  if (!trimmed) return trimmed;
  return projectCodes.findByCode(trimmed)?.project ?? trimmed;
}

export function expandSelectors(
  projectCodes: ProjectCodeLookup,
  selectors: readonly string[],
): string[] {
  const expanded = selectors
    .flatMap((selector) => selector.split(","))
    .map((selector) => expandSelector(projectCodes, selector))
    .filter((selector) => selector !== "");
  return [...new Set(expanded)];
}

/**
 * 明示指定が無いときに聞く相手 = **いまの関連プロジェクト**。
 *
 * checkout のパスではなく origin で引く。 実装は task 専用 worktree
 * (`.worktrees/<repo>-<task>`) で行う運用なので、 パス前方一致だけだと本体 checkout に
 * 居るときしか一致せず、 実際に作業している場所で答えられない。 origin は worktree でも
 * 本体と同じ値になる。 origin を持たない (まだ remote を向いていない) repository の
 * ためにパス一致も残す。
 */
export function resolveCurrentProject(
  projectCodes: ProjectCodeLookup,
  context: RepoContext,
): string {
  const byOrigin = context.repoOrigin
    ? projectCodes.findByRepoOrigin(context.repoOrigin)
    : null;
  if (byOrigin) return byOrigin.project;
  const repoPath = normalizePath(context.repoPath);
  const byPath = projectCodes.list()
    .find((row) => normalizePath(row.repo_path) === repoPath);
  if (byPath) return byPath.project;
  throw new UnknownProjectError(
    `${context.repoPath} is not a registered project; name the services explicitly.`,
  );
}
