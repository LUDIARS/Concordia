/** Shared wait semantics; unknown is distinct from human approval. SC-WAIT-01..03. */
export function decideAutomaticContinuation(input: {
  active: boolean; humanWait: boolean; pendingQuestion: boolean | "unknown";
  humanConfirmation: boolean; residentIdle: boolean; bindingMatches: boolean;
}): { allow: boolean; reason: string } {
  if (!input.active) return { allow:false,reason:"session_inactive" };
  if (!input.bindingMatches) return { allow:false,reason:"binding_changed" };
  if (input.humanWait || input.humanConfirmation || input.pendingQuestion === true) return { allow:false,reason:"waiting_human" };
  if (input.pendingQuestion === "unknown") return { allow:false,reason:"question_state_unknown" };
  if (input.residentIdle) return { allow:false,reason:"resident_idle" };
  return { allow:true,reason:"tracking_work" };
}
export function isAutomaticContinuationSource(source: string | null): boolean {
  if (!source) return false;
  if(source === "taskflow:residual:decompose:human-confirmation") return false;
  return source !== "auto:session-end" && (/^auto:/.test(source) || /^delegation:.*:(?:watchdog|continue|status)$/.test(source)
    || /^taskflow:/.test(source) || /^revisor/.test(source));
}
