/**
 * @implements spec/setup/harness-supervisor.md — 拒否理由の種別 (failure kind)
 *
 * supervisor hook が fail-closed で止めたとき「何が原因で止まったか」を機械判別できる種別と
 * 人が読める説明の組にする。許可/拒否の判定はここでは行わない (文言と分類だけ)。
 */
import type { GateOutcome } from "./supervisor-online.js";
import type { SnapshotUnusableReason } from "./supervisor-policy.js";

export type GateFailureKind =
  | "cc_unreachable" | "cc_slow" | "cc_error" | "cc_invalid_response"
  | "local_git_failed"
  | "cache_expired" | "cache_session_mismatch" | "cache_branch_mismatch" | "cache_corrupt" | "cache_missing";

export interface GateFailure { kind: GateFailureKind; message: string }

/** hook 内の git 呼び出しの失敗。どの操作が・timeout か exit code かを保持する。 */
export class LocalGitError extends Error {
  readonly status: number | null;
  readonly timedOut: boolean;
  readonly missing: boolean;
  constructor(readonly operation: string, cause: unknown) {
    const failure = (cause ?? {}) as { code?: unknown; status?: unknown; signal?: unknown };
    const timedOut = failure.code === "ETIMEDOUT" || (failure.status === null && !!failure.signal);
    const missing = failure.code === "ENOENT";
    const status = typeof failure.status === "number" ? failure.status : null;
    super(`git ${operation} ${missing ? "not found" : timedOut ? "timed out" : status !== null ? `exited ${status}` : "failed"}`, { cause });
    this.name = "LocalGitError";
    this.status = status;
    this.timedOut = timedOut;
    this.missing = missing;
  }
}

/** Cc 側の失敗 (online 2xx-4xx 以外)。online で 5xx 未満なら null。 */
export function describeCcFailure(outcome: GateOutcome): GateFailure | null {
  if (outcome.kind === "slow") {
    return { kind: "cc_slow", message: "Cc is running (/health OK) but the gate did not answer within the limit" };
  }
  if (outcome.kind === "offline") {
    return { kind: "cc_unreachable", message: "Cc did not answer the gate and /health also failed (connection refused or no response)" };
  }
  const { status, body } = outcome.response;
  if (status < 500) return null;
  const detail = errorDetail(body);
  return { kind: "cc_error", message: `Cc gate returned HTTP ${status}${detail ? ` (${detail})` : ""}` };
}

/** 200 以外の 4xx や形式不正の成功応答。 */
export function invalidResponseFailure(status: number, body: unknown): GateFailure {
  const detail = errorDetail(body);
  return { kind: "cc_invalid_response",
    message: `Cc returned an invalid gate response (HTTP ${status}${detail ? `, ${detail}` : ""})` };
}

const CACHE_MESSAGES: Record<SnapshotUnusableReason, GateFailure> = {
  expired: { kind: "cache_expired", message: "the policy cache is older than 15 minutes (or dated in the future)" },
  session_mismatch: { kind: "cache_session_mismatch", message: "the policy cache belongs to another session (or no LICTOR_SESSION_ID)" },
  branch_mismatch: { kind: "cache_branch_mismatch", message: "the policy cache was captured on another branch" },
  corrupt: { kind: "cache_corrupt", message: "the policy cache file is unreadable or malformed" },
};

/** キャッシュが使えない理由。使えるなら null。 */
export function describeCacheFailure(hadCacheFile: boolean, reason: SnapshotUnusableReason | null): GateFailure | null {
  if (!hadCacheFile) return { kind: "cache_missing", message: "no policy cache exists for this repo/session" };
  return reason ? CACHE_MESSAGES[reason] : null;
}

export function describeLocalGitFailure(error: LocalGitError): GateFailure {
  const how = error.missing ? "git executable not found" : error.timedOut ? "timed out"
    : error.status !== null ? `exit code ${error.status}` : "failed";
  return { kind: "local_git_failed", message: `local \`git ${error.operation}\` ${how} inside the hook` };
}

/** `[kind] message / [kind] message` 形式。 */
export function formatFailures(failures: readonly GateFailure[]): string {
  return failures.map((failure) => `[${failure.kind}] ${failure.message}`).join(" / ");
}

/** キャッシュも使えず復旧範囲外のときの拒否文。cc_slow のときだけ再試行を促す。 */
export function fallbackDenyReason(failures: readonly GateFailure[]): string {
  const kinds = new Set(failures.map((failure) => failure.kind));
  const guidance = kinds.has("cc_slow") && kinds.has("cache_missing")
    ? "Retry the command."
    : kinds.has("cache_missing")
      ? "Only configured recovery roots and commands are permitted."
      : "Reconnect to Cc to refresh the policy cache.";
  return `${formatFailures(failures)}. ${guidance}`;
}

function errorDetail(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const parts = [record.error, record.reason, record.stage]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.slice(0, 200));
  return [...new Set(parts)].join(": ");
}
