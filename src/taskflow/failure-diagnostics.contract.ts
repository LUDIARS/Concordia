/** @implements spec/feature/task-workflow-v3.md — CC-TF-DIAG-01 未分類例外の診断ログ */
import { redactSecrets } from "../shared/redact-secrets.js";

/** C-1: diagnostics carry no secret, no absolute path and no multi-line or oversized message. */
export default {
  post(result: unknown): boolean {
    const value = result as { error_name?: unknown; error_message?: unknown; error_site?: unknown } | null;
    if (!value || typeof value.error_name !== "string" || typeof value.error_message !== "string") return false;
    const message = value.error_message;
    if (message.length > 201 || /[\r\n]/.test(message) || redactSecrets(message) !== message) return false;
    if (/(?<![A-Za-z])[A-Za-z]:[\\/]/.test(message)) return false;
    const site = value.error_site;
    return site === null || (typeof site === "string" && !/[A-Za-z]:[\\/]|^\//.test(site) && !site.includes(" @ /"));
  },
};
