type Row = { provider: string; model_id: string; sort_order: number; is_active: number };

export default {
  post(result: { roles: { grok: Record<string, string> } }, input: { catalog: readonly Row[] }): boolean {
    const ranked = input.catalog
      .filter((row) => row.provider === "grok" && row.is_active === 1 && /^grok-\d+(?:\.\d+)?$/.test(row.model_id))
      .sort((a, b) => a.sort_order - b.sort_order);
    return result.roles.grok?.grok === (ranked[0]?.model_id ?? "grok-4.7");
  },
};
