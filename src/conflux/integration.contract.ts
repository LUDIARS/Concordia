type Binding = { decisionId: string; projectCode: string; commit: string; repository: string };
type PullRequest = { status: string; repository: string; headSha: string; id: string };

export default {
  post(result: unknown, binding: Binding, pr: PullRequest): boolean {
    if (pr.status !== "merged" || binding.repository.toLowerCase() !== pr.repository.toLowerCase()
      || !pr.headSha.startsWith(binding.commit)) return result === null;
    const event = result as { decisionId?: unknown; projectCode?: unknown; commit?: unknown; outcome?: unknown };
    return event.decisionId === binding.decisionId && event.projectCode === binding.projectCode
      && event.commit === binding.commit && event.outcome === "integrated";
  },
};
