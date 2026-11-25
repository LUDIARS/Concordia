export default {
  post(result: string[], provider: string, options?: Record<string, unknown> | null): boolean {
    if (provider !== "grok") return true;
    const requested = options?.reasoning_effort;
    const effort = typeof requested === "string" ? requested.trim().toLowerCase() : "";
    if (!/^(low|medium|high|xhigh)$/.test(effort)) return result.length === 0;
    return result.length === 2 && result[0] === "--reasoning-effort" && result[1] === effort;
  },
};
