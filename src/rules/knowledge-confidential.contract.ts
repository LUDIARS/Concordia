/** @implements spec/feature/patrol-chat.md — 秘匿語の除外 (chat-knowledge-C-3) */
interface Doc { title: string; text: string; url: string | null; repo: string | null; path: string | null }

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const terms = (args[1] as string[]).map((t) => t.trim().toLowerCase()).filter(Boolean);
    const out = result as { docs: Doc[]; excluded: number };
    const input = args[0] as Doc[];
    const hit = (d: Doc) => terms.some((t) => [d.title, d.text, d.url ?? "", d.repo ?? "", d.path ?? ""].join("\n").toLowerCase().includes(t));
    return out.docs.every((d) => !hit(d)) && out.docs.length + out.excluded === input.length;
  },
};
