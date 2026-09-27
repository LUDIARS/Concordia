import { z } from "zod";
import { unavailable } from "./contracts.js";

/** Only test selection safety; Augur remains the owner of execution and verdicts. */
export function assertStaticBundle(catalog: unknown, bundle: string): void {
  const records = z.array(z.object({ id: z.string(), runtime: z.boolean(), status: z.string(),
    domains: z.object({ business: z.array(z.string()), program: z.array(z.string()) }) })).parse(catalog);
  const colon = bundle.indexOf(":");
  const kind = colon < 0 ? bundle : bundle.slice(0, colon);
  const selector = colon < 0 ? "" : bundle.slice(colon + 1);
  const ids = new Set(selector.split(","));
  const selected = records.filter(record => kind === "ids" ? ids.has(record.id)
    : ["active", "probation"].includes(record.status)
      && (kind !== "domain" || [...record.domains.business, ...record.domains.program].includes(selector)));
  if (selected.some(record => record.runtime)) unavailable("runtime_test_workflow_required",
    "起動・実機テストは本体 checkout と Excubitor の testing claim 経路で準備してください。このツールには非 runtime の登録テスト ID を指定してください。");
}
