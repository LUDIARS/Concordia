// @spec ハーネス信頼性の実装境界
/** Fixed deterministic invariant; never invokes an LLM or emits prompt contents. */
export default {
  post(result: boolean, input: { count: number; samples: number; slot: number; lastSlot: number }) {
    if (input.samples >= 12 || input.slot <= input.lastSlot) return result === false;
    if (input.count === 1) return result === true;
    return typeof result === "boolean";
  },
};
