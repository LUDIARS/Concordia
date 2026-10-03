/** Single timer owner. Daily JST 10:00 plus same-day startup catch-up. */
import { randomUUID } from "node:crypto";
import type { ModelRoleRepo } from "../db/model-role-repo.js";
import { refreshModelRoles, type OfficialModelProviderPort } from "./refresh.js";
export function startDailyModelRefresh(input: {
  repo: ModelRoleRepo; provider: OfficialModelProviderPort; now?: () => number;
  log: { warn(message: string): void }; onAdopted?: () => void;
}): { stop(): void } {
  const now = input.now ?? Date.now;
  const owner = randomUUID();
  let stopped = false;
  let running = false;
  let controller: AbortController | null = null;
  let timeout:ReturnType<typeof setTimeout> | null = null;
  async function tick(): Promise<void> {
    if (stopped || running) return;
    running = true;
    controller = new AbortController();
    timeout = setTimeout(() => controller?.abort(), 60_000);
    try {
      const reason = await refreshModelRoles({ ...input, owner, now, signal: controller.signal });
      if (!stopped) input.onAdopted?.();
      if (reason !== "not_due_or_owned") input.log.warn(`model refresh: ${reason}`);
    } catch (error) { input.log.warn(`model refresh failed: ${error instanceof Error ? error.message : "unknown"}`); }
    finally { if(timeout) clearTimeout(timeout); timeout=null; controller = null; running = false; }
  }
  // Minute polling is only a due-day/lease check; provider I/O occurs once per day
  // (up to three bounded failed attempts), never once per tick.
  const timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  void tick();
  return { stop() { stopped = true; clearInterval(timer); if(timeout) clearTimeout(timeout); controller?.abort(); } };
}
