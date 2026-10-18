/** @implements spec/feature/patrol-chat.md — 知識の公開範囲 (chat-knowledge-C-1) */
/** The rule is restated here rather than imported, so the predicate checks the spec. */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const input = args[0] as { code: string; project: string; repoOrigin: string | null };
    const listed = (args[1] as string[]).map((p) => p.trim().toLowerCase());
    const melpot = /(^|[/:])melpot\//i.test(input.repoOrigin ?? "");
    const named = listed.includes(input.code.toLowerCase()) || listed.includes(input.project.toLowerCase());
    return result === (named && !melpot ? "public" : "hq");
  },
};
