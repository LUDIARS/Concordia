/**
 * 委託の作業場所 (cwd / branch / worktree) を、 呼び出し側の明示指定と親の作業契約から決める。
 *
 * 親と同じリポへの委託では親の作業契約が適用されるが、 以前は契約が呼び出し側の明示した
 * cwd / worktree を無条件に上書きしていた。 親が main に束縛されていると、 worktree:true と
 * feature branch を明示した委託が共有 main checkout で起動した (Actio 1bb4f41d)。
 * 人間の仕様判断 (2026-11-19 「明示優先」) に従い、 明示された値は契約に勝ち、
 * 契約は未指定の項目だけを埋める。 契約を持ち込むかどうか自体は
 * contractAppliesToDelegation (Actio 442bd0cc) が決め、 ここには適用後の契約だけが来る。
 *
 * branch の優先 (引数 > 契約) は resolveDelegationBranch が持つので、 ここでは両方を返す。
 * 純関数。
 */

export interface ExplicitDelegationTarget {
  cwd?: string;
  branch?: string;
  worktree?: boolean;
}

export interface DelegationContractTarget {
  work_location?: string | null;
  work_branch?: string | null;
}

export interface DelegationWorkTarget {
  cwd: string | undefined;
  branch: string | undefined;
  contractBranch: string | undefined;
  worktree: boolean | undefined;
}

export function resolveDelegationWorkTarget(input: {
  explicit: ExplicitDelegationTarget;
  contract: DelegationContractTarget | null;
  parentRepoPath: string | null | undefined;
}): DelegationWorkTarget {
  const { explicit, contract } = input;
  const explicitCwd = explicit.cwd?.trim() ? explicit.cwd : undefined;
  const contractCwd = contract?.work_location === "repo-root" ? input.parentRepoPath ?? undefined : undefined;
  return {
    cwd: explicitCwd ?? contractCwd,
    branch: explicit.branch,
    contractBranch: contract?.work_branch ?? undefined,
    worktree: explicit.worktree !== undefined
      ? explicit.worktree
      : contract ? contract.work_location === "worktree" : undefined,
  };
}
