/** @implements spec/feature/glab-unity-hub.md — C-8 pullRequestForSpecDraft (guh-C-8) */
const ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [repo, payload, bindings] = args as [string, Record<string, unknown> | null, readonly { repo: string }[]];
    const listed = bindings.some((binding) => binding.repo.toLowerCase() === repo.toLowerCase());
    const action = typeof payload?.action === "string" ? payload.action : "";
    if (!listed || !ACTIONS.has(action)) return result === null;
    return result === null || (typeof result === "object" && (result as { repo?: string }).repo === repo);
  },
};
