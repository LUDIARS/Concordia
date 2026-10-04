/** Only categorical decisions leave the classifier. Never echo the sensitive input or matched term. */
export type ConsultationSafetyReason = "personal_data" | "confidential_data" | "unsafe_tool" | "guard_unavailable";
export interface ConsultationSafetyDecision { blocked: boolean; reason: ConsultationSafetyReason | null; penaltyEligible: boolean }

export function safetyDecision(reason: ConsultationSafetyReason | null): ConsultationSafetyDecision {
  return { blocked: reason !== null, reason, penaltyEligible: reason === "personal_data" || reason === "confidential_data" };
}

export function consultationToolAllowed(tool: string): boolean {
  return ["WebSearch", "WebFetch", "TodoWrite", "Skill", "web_search", "web.run"].includes(tool);
}

export function parseSafetyVerdict(raw: string): ConsultationSafetyDecision {
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")) as { decision?: unknown; category?: unknown };
    if (parsed.decision === "allow" && parsed.category === "none") return safetyDecision(null);
    if (parsed.decision === "deny" && (parsed.category === "personal_data" || parsed.category === "confidential_data")) {
      return safetyDecision(parsed.category);
    }
  } catch { /* Malformed classifier output is a block, never permission or a penalty. */ }
  return safetyDecision("guard_unavailable");
}
