export default {
  post(value: { has_diff: boolean; summary: string; current_summary?: string } | null,
    output: string, completed: boolean): boolean {
    if (!completed) return value === null;
    let raw: unknown;
    try { raw = JSON.parse(output); } catch { return value === null; }
    const candidate = raw as Partial<NonNullable<typeof value>> | null;
    const validText = (text: unknown) => typeof text === "string" && !!text.trim() && text.length <= 16_000;
    if (candidate?.has_diff === false && typeof candidate.summary === "string" && !candidate.summary.trim()) {
      return value?.has_diff === false && value.summary === "";
    }
    if (candidate?.has_diff === true && validText(candidate.summary) && validText(candidate.current_summary)) {
      return value?.has_diff === true && value.summary === candidate.summary?.trim()
        && value.current_summary === candidate.current_summary?.trim();
    }
    return value === null;
  },
};
