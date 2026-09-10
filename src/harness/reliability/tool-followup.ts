// @spec ハーネス信頼性の実装境界
import { createHash } from "node:crypto";
import type { ReliabilityState } from "./state.js";

/** Deterministic observations only. A tool call is evidence of use, never proof of correct research. */
export function observeToolFollowup(state: ReliabilityState, input: {
  event_id: string; tool?: string; failed?: boolean; status?: number; code?: string; message?: string;
}, at: number): string {
  const tracker = state.tools ??= { seen: [] };
  if (tracker.seen.includes(input.event_id)) return "";
  tracker.seen = [...tracker.seen, input.event_id].slice(-100);
  const tool = input.tool ?? "unknown";
  const advice: string[] = [];
  const service = /^mcp__(praeforma|pf|anatomia|an|actio|memoria)__/.exec(tool)?.[1];
  if (service && !input.failed) state.observations[`tool_use_${service}`] = {
    at, status: "successful_call_observed", reason: "Tool envelope observed; project match and use of results are not verified",
  };
  if (!input.failed) tracker.failure = undefined;
  else {
    const fingerprint = createHash("sha256").update(`${tool}|${input.status ?? ""}|${input.code ?? ""}|${(input.message ?? "").replace(/\d+/g, "#").slice(0, 1000)}`).digest("hex");
    const old = tracker.failure;
    const count = old?.fingerprint === fingerprint && at - old.at < 300_000 ? old.count + 1 : 1;
    tracker.failure = { fingerprint, count, at };
    if (count >= 3) {
      state.observations.tool_retry = { at, status: "repeated_failure", reason: `${count} consecutive matching failures; no automatic retry` };
      if (count === 3) advice.push("同じツールの失敗が3回続いています。cc-harness-recoveryで原因を確認し、同じ呼び出しをそのまま繰り返さないでください。");
    }
    const mutation = /^mcp__.+__(?:.*_)?(?:create|insert|update|delete|submit|send|post|add)(?:_|$)/i.test(tool);
    const uncertain = (input.status ?? 0) >= 500 || /timeout|timed.out|ECONNRESET|ETIMEDOUT|network|socket/i.test(`${input.code ?? ""} ${input.message ?? ""}`);
    if (mutation && uncertain) {
      state.observations.mutation_result = { at, status: "unknown", reason: "External mutation outcome unknown; reconcile its existing request/resource ID before resending" };
      advice.push("外部更新の結果が不明です。元のリクエストID・対象IDで成否を照合してから再送を判断してください。無関係な読み取り成功では解消扱いにしません。");
    }
  }
  return advice.join("\n");
}
