/**
 * @implements spec/setup/harness-supervisor.md — gate の既知失敗を理由付き deny にする
 *
 * gate がリポ文脈を解けなかったとき (detached HEAD など) を素の 5xx 例外にせず、
 * hook が種別を表示できる明示応答に変換する。判定は deny のまま緩めない。
 */
import type { ImplementationBindFailure } from "../implementation-tools/bind-failure.js";

export interface BindFailureDenial {
  decision: "deny";
  blocked: true;
  reason: string;
  error: ImplementationBindFailure["reason"];
  stage: ImplementationBindFailure["stage"];
  hits: Array<{ rule: string; decision: "deny"; reason: string }>;
}

const GUIDANCE: Partial<Record<ImplementationBindFailure["reason"], string>> = {
  unnamed_branch: "The checkout is on a detached HEAD (no branch name). Switch to a named branch or cd to a checkout that has one.",
  git_timeout: "git did not answer in time on the Cc side. Retry the command.",
  git_unavailable: "git is not available to Cc.",
  git_ownership: "git refused the repository (dubious ownership).",
  git_not_repository: "The working directory is not inside a git repository.",
  invalid_cwd: "The hook sent no absolute working directory.",
};

export function bindFailureDenial(failure: ImplementationBindFailure): BindFailureDenial {
  const guidance = GUIDANCE[failure.reason] ?? "Cc could not resolve the repository context.";
  const reason = `[cc_error] Cc gate could not resolve the ${failure.stage} (${failure.reason}). ${guidance}`;
  return { decision: "deny", blocked: true, reason, error: failure.reason, stage: failure.stage,
    hits: [{ rule: `gate-${failure.stage}-${failure.reason}`, decision: "deny", reason }] };
}
