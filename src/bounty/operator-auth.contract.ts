/** @implements SPEC-BOUNTY-TRIAGE */
/** C-6: an operator passes only with the key of its own route; unset or empty keys never pass. */
export default {
  post(
    result: unknown,
    input: { platform?: unknown; provided?: unknown; botToken?: unknown; cocoiruKey?: unknown } | undefined,
  ): boolean {
    if (typeof result !== "boolean") return false;
    const expected = input?.platform === "discord" ? input.botToken : input?.platform === "cocoiru" ? input.cocoiruKey : null;
    const filled = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
    const matches = filled(expected) && filled(input?.provided) && expected.trim() === (input!.provided as string).trim();
    return result === matches;
  },
};
