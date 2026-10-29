import { StatusSchema } from "./status-schema.js";

/** C-20: input values and parser messages must never become diagnostics. */
export default {
  post(result: unknown, text: string): boolean {
    const report = result as { valid: boolean; issues: Record<string, unknown>[] };
    let expected = false;
    try { expected = StatusSchema.safeParse(JSON.parse(text)).success; }
    catch { /* Invalid JSON is an expected input, not an execution failure. */ }
    return report.valid === expected && Array.isArray(report.issues)
      && (expected ? report.issues.length === 0 : report.issues.length > 0)
      && report.issues.every(issue => Object.keys(issue).every(key =>
        ["field", "code", "limit", "length"].includes(key))
        && typeof issue.field === "string" && typeof issue.code === "string"
        && (issue.limit === undefined || typeof issue.limit === "number")
        && (issue.length === undefined || typeof issue.length === "number"));
  },
};
