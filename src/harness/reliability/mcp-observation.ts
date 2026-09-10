// @spec ハーネス信頼性の実装境界
export type McpOutcome = "auth_required" | "permission_denied" | "rate_limited" | "network_error" | "success" | "unknown";
export interface McpEvidence {
  tool: string;
  failed: boolean;
  status?: number;
  code?: string;
  message: string;
}

/** Do not turn arbitrary tool text mentioning 401 into an authentication failure. */
export function classifyMcpOutcome(evidence: McpEvidence): McpOutcome {
  if (!evidence.failed) return "success";
  const error = `${evidence.code ?? ""} ${evidence.message}`;
  if (evidence.status === 401 || /\b(invalid_grant|unauthorized|authentication_required|token_expired|auth required)\b|(?:access|refresh) token (?:has )?expired|re-?authenticat(?:e|ion).*required|認証.*(?:期限切れ|失効)/i.test(error)) return "auth_required";
  if (evidence.status === 403 || /\b(forbidden|permission.denied|insufficient.scope)\b/i.test(error)) return "permission_denied";
  if (evidence.status === 429 || /\b(rate.limit|too.many.requests)\b/i.test(error)) return "rate_limited";
  if (/\b(ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET)\b|network error/i.test(error)) return "network_error";
  return "unknown";
}

/** Advisory only. Command wording, claim and ordinary quoted instructions are insufficient. */
export function injectionSignals(text: string): string[] {
  const signals: string[] = [];
  // Deliberately require an override plus a concrete unrelated action/secret target.
  const override = /ignore (?:all |the )?(?:previous|system|developer) instructions|override (?:system|developer)|(?:システム|上位)指示を無視/i.test(text);
  const exfiltrate = /(?:send|upload|post|送信|アップロード).{0,100}(?:api.?key|secret|password|credentials|秘密鍵|認証情報)/is.test(text);
  const impersonate = /(?:I am|source\s*[:=]|発信元\s*[:：]).{0,20}(?:Concordia|Cc).{0,100}(?:bypass|disable|権限昇格|ガードを解除)/is.test(text);
  if (override && exfiltrate) signals.push("instruction_override_with_secret_request");
  if (impersonate) signals.push("unverified_control_source_claim");
  return signals;
}

export function mcpServerKey(tool: string): string | null {
  const match = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(tool);
  return match?.[1] ?? null;
}
