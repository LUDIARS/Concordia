/** @implements spec/feature/daily-goal-run.md — 2. 読み取りは本文に書かれていることだけ / CC-DG-INV-09 */
/** Every kept field is backed by a quote found in the normalized post; an unbacked permission stays denied. */
function normalize(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const body = normalize(String(args[0] ?? ""));
    const r = result as { extracted?: { project?: string; goalText?: string; acceptance: string[]; permissions: Record<string, boolean>; actioTaskIds: string[]; quotes: Record<string, string> } } | null;
    const e = r?.extracted;
    if (!e) return false;
    const grounded = (field: string) => {
      const quote = normalize(e.quotes[field] ?? "");
      return quote.length > 0 && body.includes(quote);
    };
    if (e.project && !grounded("project")) return false;
    if (e.goalText && !grounded("goalText")) return false;
    if (!e.acceptance.every((_, index) => grounded(`acceptance.${index}`))) return false;
    if (!Object.entries(e.permissions).every(([key, value]) => !value || grounded(`permissions.${key}`))) return false;
    return e.actioTaskIds.every((id) => body.includes(id));
  },
};
