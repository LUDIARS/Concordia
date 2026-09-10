// @spec ハーネス信頼性の実装境界
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// Read the identity/criterion projection of Augur's existing v1 manifest, not a second contract format.
const Manifest = z.object({ version: z.literal(1), contracts: z.array(z.object({ id: z.string().min(1), criterion: z.string().min(1) })).max(200) });
export type AcceptanceManifest = { status: "absent" | "invalid"; criteria: string[] } | { status: "present"; criteria: string[] };

export function readAcceptanceManifest(cwd: string): AcceptanceManifest {
  const path = join(cwd, "augur.contracts.json");
  try {
    if (statSync(path).size > 1024 * 1024) return { status: "invalid", criteria: [] };
    const parsed = Manifest.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success || !parsed.data.contracts.length || new Set(parsed.data.contracts.map((entry) => entry.id)).size !== parsed.data.contracts.length) return { status: "invalid", criteria: [] };
    return { status: "present", criteria: parsed.data.contracts.map((entry) => entry.criterion) };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid", criteria: [] };
  }
}
