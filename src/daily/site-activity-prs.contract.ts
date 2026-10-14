/** @implements SPEC-FED-SITE-ACTIVITY */
/** site-activity-prs-C-1: only PRs whose recorded submitter is that session, unique, newest-first capped. */
interface Pr { source: string; repo: string; number: number }
interface Local { number: number; repository: string; sessionId?: string | null }
interface Github { repo_origin: string; number: number; author_session_id: string | null }

export default {
  post(result: unknown, sessionIds: readonly string[], localPrs: readonly Local[], githubPrs: readonly Github[], limit?: number): boolean {
    if (!(result instanceof Map)) return false;
    const cap = limit ?? 5;
    for (const [sessionId, prs] of result as Map<string, Pr[]>) {
      if (!sessionIds.includes(sessionId) || !Array.isArray(prs) || prs.length > cap) return false;
      const keys = new Set<string>();
      for (const pr of prs) {
        const key = `${pr.source}:${pr.repo}#${pr.number}`;
        if (keys.has(key)) return false;
        keys.add(key);
        const recorded = pr.source === "local"
          ? localPrs.some((l) => l.sessionId === sessionId && l.number === pr.number && l.repository.trim().startsWith(pr.repo.replace(/…$/, "")))
          : githubPrs.some((g) => g.author_session_id === sessionId && g.number === pr.number && g.repo_origin.trim().startsWith(pr.repo.replace(/…$/, "")));
        if (!recorded) return false;
      }
    }
    return true;
  },
};
