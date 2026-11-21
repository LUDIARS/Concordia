import type { AgyGeneration } from "./agy-usage-metadata.js";
import { geminiStandardPrice } from "./price-table.js";
import type { SessionCostEstimate } from "./session-cost.js";

export function estimateAgyCost(rows: readonly AgyGeneration[]): SessionCostEstimate | null {
  if (rows.length === 0) return null;
  const models = new Set<string>();
  let usd = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  for (const row of rows) {
    if (row.model) models.add(row.model);
    const price = geminiStandardPrice(row.model, row.atMs);
    if (!price) {
      unpricedTokens += row.total;
      continue;
    }
    pricedTokens += row.total;
    usd += (row.input * price.inputPerMtok + row.cached * price.cachedInputPerMtok
      + row.output * price.outputPerMtok) / 1_000_000;
  }
  return { usd, pricedTokens, unpricedTokens, models: [...models] };
}
