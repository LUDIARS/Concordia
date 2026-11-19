/**
 * Revisor の catalog 宣言ポートを読む (SPEC-REVISOR-ENDPOINT-FALLBACK)。
 *
 * ポートの正本は Excubitor catalog (port-source-rule)。 Excubitor が応答しないときでも
 * 同じ正本 (`<root>/Revisor/excubitor.catalog.yaml`) の宣言値を候補にできるよう、
 * fragment を直接読む。 ここではハードコードしない。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { load } from "js-yaml";

const REVISOR_SERVICE_CODE = "revisor";

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

/** catalog fragment の YAML から services[code].port を返す。 欠落・不正値・解析失敗は null。 */
export function declaredServicePort(yamlText: string, code: string): number | null {
  let catalog: unknown;
  try {
    catalog = load(yamlText);
  } catch {
    return null;
  }
  const services = catalog && typeof catalog === "object"
    ? (catalog as { services?: unknown }).services
    : null;
  if (!Array.isArray(services)) return null;
  const service = services.find((row) =>
    row && typeof row === "object" && (row as { code?: unknown }).code === code,
  ) as { port?: unknown } | undefined;
  return validPort(service?.port) ? service.port : null;
}

/** `<workspaceRoot>/Revisor/excubitor.catalog.yaml` の revisor 宣言ポート。 読めなければ null。 */
export async function readRevisorCatalogPort(workspaceRoot: string): Promise<number | null> {
  if (!workspaceRoot) return null;
  try {
    const text = await readFile(join(workspaceRoot, "Revisor", "excubitor.catalog.yaml"), "utf8");
    return declaredServicePort(text, REVISOR_SERVICE_CODE);
  } catch {
    return null;
  }
}
