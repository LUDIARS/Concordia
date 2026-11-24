/**
 * 定時ジョブの宛先 (従来の委託 / dots / Muse) を WebUI から切り替える管理 API
 * (spec/feature/parttimer-agent-dispatch.md)。 loopback 前提で追加認証は無い (他の /v1/admin と同じ)。
 *
 *   PUT /v1/admin/cron-jobs/:name/agent        { agent: "" | "dots" | "muse" | null }
 *   PUT /v1/admin/cron-jobs-agent-fallback     { minutes: number }
 *
 * data builder の無いジョブを外部エージェントへ切り替える要求は 400 (CC-PT-AGENT-INV-06)。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 宛先の切替 API
 */

import type { Hono } from "hono";
import type { InstructionAgent } from "../agent-instructions/instruction-policy.js";
import { parseAgentChoice } from "../scheduler/agent-dispatch-policy.js";
import { hasAgentJob } from "../scheduler/agent-jobs/registry.js";
import type { CronJobDefinition } from "../scheduler/cron-jobs.js";

export interface CronJobAgentSettings {
  getCronJobAgent(jobName: string): InstructionAgent | null;
  setCronJobAgent(jobName: string, agent: InstructionAgent | null): void;
  getCronJobAgentFallbackMinutes(): number;
  setCronJobAgentFallbackMinutes(minutes: number): void;
}

/** GET /v1/admin/cron-jobs の 1 行に足す宛先の欄。 */
export function serializeCronJobAgent(job: Pick<CronJobDefinition, "name">, settings: CronJobAgentSettings) {
  return { agent: settings.getCronJobAgent(job.name) ?? "", agent_supported: hasAgentJob(job.name) };
}

export function registerCronJobAgentRoutes(
  app: Hono,
  deps: { jobs: readonly CronJobDefinition[]; settings: CronJobAgentSettings },
): void {
  app.put("/v1/admin/cron-jobs/:name/agent", async (c) => {
    const name = c.req.param("name");
    const job = deps.jobs.find((candidate) => candidate.name === name);
    if (!job) return c.json({ error: `unknown cron job: ${name}` }, 404);
    const body = await c.req.json().catch(() => null) as { agent?: unknown } | null;
    if (!body || !("agent" in body)) return c.json({ error: "body.agent (\"\", \"dots\", \"muse\" or null) required" }, 400);
    const choice = parseAgentChoice(body.agent);
    if (!choice.ok) return c.json({ error: choice.error }, 400);
    if (choice.agent !== null && !hasAgentJob(name)) {
      return c.json({ error: `cron job has no agent data builder: ${name}` }, 400);
    }
    deps.settings.setCronJobAgent(name, choice.agent);
    return c.json({ job: { name, ...serializeCronJobAgent(job, deps.settings) } });
  });

  app.get("/v1/admin/cron-jobs-agent-fallback", (c) => c.json({ minutes: deps.settings.getCronJobAgentFallbackMinutes() }));

  app.put("/v1/admin/cron-jobs-agent-fallback", async (c) => {
    const body = await c.req.json().catch(() => null) as { minutes?: unknown } | null;
    if (!body || typeof body.minutes !== "number") return c.json({ error: "body.minutes (integer) required" }, 400);
    try {
      deps.settings.setCronJobAgentFallbackMinutes(body.minutes);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    return c.json({ minutes: deps.settings.getCronJobAgentFallbackMinutes() });
  });
}
