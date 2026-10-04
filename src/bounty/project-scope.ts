import { contract } from './ontime-runtime.js'; /* augur-inject:import:5bae0136 */
import augurContract_591ce9d6 from './project-scope.contract.js'; /* augur-inject:contract-predicate:91bf9dd3 */
/**
 * 報告の対象プロジェクトを project registry と会社の範囲で確かめる純関数
 * (spec/feature/bug-bounty.md §3、 CC-INV-02)。
 *
 * 子会社は関係プロジェクト (subsidiary_projects) の範囲だけを対象にできる
 * (subsidiary-delegation.md §3.4 を継承)。 コード未指定は「対象未特定」として通し、 仕分けが推定する。
 *
 * @implements SPEC-BOUNTY-INTAKE
 */

export interface BountyProject {
  code: string;
  project: string;
}

export type BountyProjectDenial = "unknown_project" | "project_outside_company_scope";

export type BountyProjectResult =
  | { ok: true; project: BountyProject | null }
  | { ok: false; denial: BountyProjectDenial };

/**
 * @param code 報告者が指定したコード (未指定は null)
 * @param registered project registry の登録
 * @param companyProjects 報告者の会社の関係プロジェクト。 本社は null (制限なし)。
 */
export function checkBountyReportProject(input: {
  code: string | null;
  registered: ReadonlyArray<BountyProject>;
  companyProjects: readonly string[] | null;
}): BountyProjectResult {
  const code = (input.code ?? "").trim();
  if (!code) return { ok: true, project: null };
  const project = matchProjectCode(code, input.registered);
  if (!project) return { ok: false, denial: "unknown_project" };
  if (input.companyProjects !== null && !isInCompanyScope(project, input.companyProjects)) {
    return { ok: false, denial: "project_outside_company_scope" };
  }
  return { ok: true, project: { code: project.code, project: project.project } };
}
// @ts-expect-error augur-inject
checkBountyReportProject = contract(checkBountyReportProject, { ...augurContract_591ce9d6, contractId: 'bounty-intake-C-4', mode: 'observe', sample: 1, where: 'src/bounty/project-scope.ts:27', rule: 'contract-wrap', id: '591ce9d6' }); /* augur-inject:contract-wrap:591ce9d6 */

/** 会社の範囲で報告できるプロジェクト (コマンドの補完用)。 */
export function bountyProjectsInScope(
  registered: ReadonlyArray<BountyProject>,
  companyProjects: readonly string[] | null,
): BountyProject[] {
  return registered
    .filter((project) => companyProjects === null || isInCompanyScope(project, companyProjects))
    .map((project) => ({ code: project.code, project: project.project }));
}

/**
 * コードは大文字小文字を区別する (`LD` と `Ld` は別プロジェクト)。 完全一致が無いときだけ、
 * 大文字小文字を畳んで 1 件に決まるものを採る。 2 件以上に当たるなら決めない。
 */
function matchProjectCode(code: string, registered: ReadonlyArray<BountyProject>): BountyProject | null {
  const exact = registered.find((project) => project.code === code);
  if (exact) return exact;
  const folded = registered.filter((project) => project.code.toLowerCase() === code.toLowerCase());
  return folded.length === 1 ? folded[0]! : null;
}

function isInCompanyScope(project: BountyProject, companyProjects: readonly string[]): boolean {
  const names = [project.code.toLowerCase(), project.project.trim().toLowerCase()];
  return companyProjects.some((candidate) => names.includes(candidate.trim().toLowerCase()));
}
