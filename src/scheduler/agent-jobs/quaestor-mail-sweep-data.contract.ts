export default {
  post(result: unknown): boolean {
    if (result === null) return true;
    if (!result || typeof result !== "object") return false;
    const allowed = ["fetched", "processed", "committed", "needs_review", "notified", "errors", "disabled"];
    const row = result as Record<string, unknown>;
    return Object.keys(row).length === allowed.length && allowed.every((key) => Object.hasOwn(row, key))
      && ["fetched", "committed", "needs_review", "notified"].every((key) => {
        const count = row[key];
        return typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
      })
      && typeof row.disabled === "boolean"
      && !!row.processed && typeof row.processed === "object"
      && Object.keys(row.processed).sort().join(",") === "ci_failure,cloud_notice,dependabot,ignore,invoice"
      && Array.isArray(row.errors) && row.errors.every((error: { message_id?: unknown; kind?: unknown }) =>
        Object.keys(error).sort().join(",") === "kind,message_id"
        && typeof error.message_id === "string" && /^(?:\*|[a-f0-9]{1,32})$/i.test(error.message_id)
        && ["auth", "rate_limit", "not_found", "network", "invalid_response", "processing_error"].includes(String(error.kind)));
  },
};
