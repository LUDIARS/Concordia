import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { load } from "js-yaml";

/** The owning service catalog supplies the public user origin; no projected callback URL is trusted. */
export async function readSprintActioOrigin(workspaceRoot: string): Promise<string> {
  const catalog = load(await readFile(join(workspaceRoot, "Actio", "excubitor.catalog.yaml"), "utf8")) as { services?: Array<{ code?: string; env?: Record<string, unknown> }> };
  const value = catalog.services?.find(s => s.code === "actio")?.env?.ACTIO_CF_PUBLIC_ORIGIN;
  if (typeof value !== "string") throw new Error("Actio catalogの公開URLが未設定です。");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Actio catalogの公開originが不正です。");
  return url.origin;
}
