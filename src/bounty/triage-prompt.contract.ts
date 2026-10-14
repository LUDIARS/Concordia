/** @implements SPEC-BOUNTY-TRIAGE */
/**
 * C-1: the report text sits only inside the material fences (CC-BOUNTY-INV-01). The instruction
 * part before the first fence never contains the text, and the text cannot forge a closing fence.
 */
const MIN_LEAK_CHARS = 12;

export default {
  post(result: unknown, input: { whatHappened?: unknown; reproSteps?: unknown; nonce?: unknown } | undefined): boolean {
    if (typeof result !== "string") return false;
    const nonce = String(input?.nonce ?? "").replace(/[^A-Za-z0-9]/gu, "").slice(0, 32) || "0";
    const firstFence = result.indexOf(`<<<BOUNTY-MATERIAL ${nonce} `);
    if (firstFence < 0) return false;
    const instructions = result.slice(0, firstFence);
    for (const text of [input?.whatHappened, input?.reproSteps]) {
      if (typeof text !== "string") continue;
      const trimmed = text.trim();
      if (trimmed.length >= MIN_LEAK_CHARS && instructions.includes(trimmed)) return false;
    }
    // Exactly three closing fences (what_happened, repro_steps, open_reports): text cannot add one.
    const closings = result.split(`<<<END-BOUNTY-MATERIAL ${nonce} `).length - 1;
    return closings === 3;
  },
};
