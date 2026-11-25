export default {
  post(result: { provider: string; args: string[]; effectiveModel: string | null; env?: unknown },
    target: string, model?: string | null): boolean {
    if (target !== "grok") return true;
    const expected = model?.trim() || "grok-4.7";
    return result.provider === "grok" && result.effectiveModel === expected && result.env === undefined
      && result.args.length === 2 && result.args[0] === "--model" && result.args[1] === expected;
  },
};
