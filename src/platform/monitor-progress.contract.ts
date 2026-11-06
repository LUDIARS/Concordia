export default {
  post(result: unknown, _text: unknown, task: unknown): boolean {
    if (result === null) return true;
    if (!result || typeof result !== "object") return false;
    const r = result as Record<string, unknown>;
    return r.task === task && typeof r.percent === "number" && Number.isFinite(r.percent)
      && r.percent >= 0 && r.percent <= 100 && typeof r.evidence === "string" && !!r.evidence.trim()
      && (r.percent !== 100 || (r.complete === true && Array.isArray(r.remaining) && r.remaining.length === 0));
  },
};
