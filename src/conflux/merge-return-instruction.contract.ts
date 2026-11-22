type Instruction = { body: string; params: Record<string, string> };
type Target = { project_code: string; merge_commit_sha: string; branch: string };

export default {
  post(result: Instruction, target: Target, dedupeKey: string, build: boolean, repository: string | null): boolean {
    const p = result.params;
    const base = p.project_code === target.project_code && p.merge_commit_sha === target.merge_commit_sha
      && p.branch === target.branch && p.dedupe_key === dedupeKey;
    if (build) return base && p.build === undefined;
    return base && p.build === "agent" && (repository === null || p.repository === repository)
      && result.body.includes(target.merge_commit_sha) && result.body.includes("ビルド") && result.body.includes("result");
  },
};
