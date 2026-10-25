export default {
  postThrow(error: unknown): boolean { return error instanceof Error && error.message === "orbis_invalid_request"; },
  post(result: unknown): boolean {
    if (!result || typeof result !== "object") return false;
    const r = result as { operation?: string; action?: { type?: string; text?: string } };
    if (!["attach", "detach", "open", "navigate", "read", "act", "logs", "reveal"].includes(r.operation ?? "")) return false;
    if (r.operation !== "act") return true;
    return ["click", "type", "scroll", "select"].includes(r.action?.type ?? "")
      && (r.action?.type !== "type" || (typeof r.action.text === "string" && r.action.text.length > 0 && r.action.text.length <= 2000));
  },
};
