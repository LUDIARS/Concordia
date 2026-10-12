import { redactSecrets } from "../shared/redact-secrets.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:e13d83ba */
import augurContract_0a55a9eb from './failure-diagnostics.contract.js'; /* augur-inject:contract-predicate:ce859f1d */

/**
 * Log-only diagnostics for exceptions that `describeTaskflowFailure` cannot classify.
 * Never returned to API clients: responses keep the fixed reason code only.
 */
export interface TaskflowFailureDiagnostics {
  error_name: string;
  /** Secret-redacted, URL-query-stripped, single-line and length-capped message. */
  error_message: string;
  /** First application stack frame as a repository-relative `path:line:col` (no absolute path). */
  error_site: string | null;
  cause_name: string | null;
  /** Only identifier-shaped codes such as `ECONNRESET` / `UND_ERR_CONNECT_TIMEOUT`. */
  cause_code: string | null;
}

export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 200;

const SAFE_NAME = /^[A-Za-z_$][\w$]{0,63}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const STACK_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
const REPO_SEGMENT = /[\\/]((?:src|dist|tests|lib)[\\/].+)$/;

function safeName(value: unknown): string | null {
  return typeof value === "string" && SAFE_NAME.test(value) ? value : null;
}

function safeMessage(message: string): string {
  const singleLine = redactSecrets(message)
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/gi, "$1?[REDACTED]")
    .replace(/(?<![A-Za-z])[A-Za-z]:[\\/][^\s:'"]*/g, "[PATH]")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH
    ? `${singleLine.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH)}…`
    : singleLine;
}

/** Picks the first non-dependency, non-runtime frame and reduces it to a repository-relative site. */
export function applicationStackSite(stack: string | undefined): string | null {
  if (!stack) return null;
  for (const line of stack.split("\n").slice(1)) {
    const frame = STACK_FRAME.exec(line);
    if (!frame) continue;
    const location = frame[2]!.replace(/^file:\/\/\/?/, "");
    if (location.startsWith("node:") || /[\\/]node_modules[\\/]/.test(location)) continue;
    const relative = REPO_SEGMENT.exec(location)?.[1]?.replace(/\\/g, "/");
    if (!relative) continue;
    const fn = frame[1]?.replace(/^async\s+/, "").split(" ")[0];
    const site = `${relative}:${frame[3]}:${frame[4]}`;
    return fn && /^[\w$.<>]{1,80}$/.test(fn) ? `${fn} @ ${site}` : site;
  }
  return null;
}

/**
 * Structured log fields for a taskflow HTTP failure. Classified failures keep reason/status only;
 * unclassified ones (`taskflow_internal_error`) add the safe diagnostics above.
 */
export function taskflowFailureLogFields(
  failure: { code: string; status: number },
  error: unknown,
): { reason: string; status: number } & Partial<TaskflowFailureDiagnostics> {
  const base = { reason: failure.code, status: failure.status };
  return failure.code === "taskflow_internal_error" ? { ...base, ...describeTaskflowFailureDiagnostics(error) } : base;
}

export function describeTaskflowFailureDiagnostics(error: unknown): TaskflowFailureDiagnostics {
  if (!(error instanceof Error)) {
    return { error_name: `non-error:${error === null ? "null" : typeof error}`, error_message: "",
      error_site: null, cause_name: null, cause_code: null };
  }
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  return {
    error_name: safeName(error.name) ?? safeName(error.constructor?.name) ?? "Error",
    error_message: safeMessage(String(error.message ?? "")),
    error_site: applicationStackSite(error.stack),
    cause_name: cause instanceof Error ? safeName(cause.name) : null,
    cause_code: typeof causeCode === "string" && SAFE_CODE.test(causeCode) ? causeCode : null,
  };
}
// @ts-expect-error augur-inject
describeTaskflowFailureDiagnostics = contract(describeTaskflowFailureDiagnostics, { ...augurContract_0a55a9eb, contractId: 'tf-diag-C-1', mode: 'observe', sample: 1, where: 'src/taskflow/failure-diagnostics.ts:57', rule: 'contract-wrap', id: '0a55a9eb' }); /* augur-inject:contract-wrap:0a55a9eb */
