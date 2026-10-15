/** @implements spec/feature/delegation.md#状態照会と終端報告の分離 */
export default {
  post(result: unknown): boolean {
    if (!Array.isArray(result) || !result.every((line) => typeof line === "string")) return false;
    const text = result.join("\n");
    if (!text.includes("人間判断・権限待ちは `kind=wait`")) return false;
    if (!text.includes("実行可能な作業は `kind=work`")) return false;
    if (!text.includes("kind を省略して判断待ちを報告しない")) return false;
    const examples = [...text.matchAll(/```json\n([^`]+)\n```/g)];
    const kinds = new Set<string>();
    try {
      for (const [, json] of examples) {
        const report = JSON.parse(json);
        if (report.status !== "partial" || !Array.isArray(report.remaining)) return false;
        for (const item of report.remaining) {
          if (!["work", "wait"].includes(item.kind) || !item.title || !item.note || !Array.isArray(item.scope_dirs)) return false;
          kinds.add(item.kind);
        }
      }
    } catch { return false; }
    return kinds.has("work") && kinds.has("wait");
  },
};
