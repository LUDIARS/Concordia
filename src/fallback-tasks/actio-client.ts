import { z } from "zod";
import type { ExcubitorClient } from "../excubitor/client.js";
import { actioTaskPages } from "../taskflow/actio-task-pages.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import type { CcTaskRow } from "./types.js";

export type ActioFailureOutcome = "unavailable" | "unknown" | "rejected";

export class ActioTaskError extends Error {
  constructor(message: string, readonly outcome: ActioFailureOutcome) {
    super(message);
    this.name = "ActioTaskError";
  }
}

const ActioTaskSummary = z.object({ id: z.string(), pluginRef: z.string().nullable().optional() });
type ActioTask = z.infer<typeof ActioTaskSummary>;

/** @implements spec/feature/cc-task-fallback.md */
export class ActioTaskClient {
  constructor(
    private readonly excubitor: Pick<ExcubitorClient, "findService">,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5_000,
  ) {}

  /** Pages through the Concordia-plugin tasks and stops at the first page that holds the match. */
  async findByConcordiaId(id: string): Promise<ActioTask | null> {
    const query = new URLSearchParams({ scope: "all", pluginId: "concordia" });
    const pages = actioTaskPages((path) => this.request("GET", path, undefined, "unavailable"), query, ActioTaskSummary);
    try {
      for await (const page of pages) {
        const found = page.find((task) => task.pluginRef === id);
        if (found) return found;
      }
    } catch (error) {
      if (error instanceof ActioTaskError) throw error;
      throw new ActioTaskError("Invalid Actio task list response", "unavailable");
    }
    return null;
  }

  async create(task: CcTaskRow): Promise<ActioTask> {
    const body = await this.request<{ task?: ActioTask }>("POST", "/api/tasks", this.payload(task), "unknown");
    if (!body.task?.id) throw new ActioTaskError("Actio returned no task id", "unknown");
    return body.task;
  }

  async update(remoteId: string, task: CcTaskRow): Promise<void> {
    await this.request("PATCH", `/api/tasks/${encodeURIComponent(remoteId)}`, this.payload(task), "unavailable");
  }

  private payload(task: CcTaskRow): Record<string, unknown> {
    return {
      title: task.title,
      details: task.details,
      status: task.status,
      kind: task.kind,
      creator_type: task.creator_type,
      category: task.category,
      due_at: task.due_at,
      pluginId: "concordia",
      pluginRef: task.id,
    };
  }

  private async request<T>(method: "GET" | "POST" | "PATCH", path: string, body: unknown, networkOutcome: ActioFailureOutcome): Promise<T> {
    let service;
    try { service = await this.excubitor.findService("actio", this.timeoutMs); }
    catch { throw new ActioTaskError("Actio catalog unavailable", "unavailable"); }
    const port = resolveServicePort(service);
    if (!service || service.state !== "running" || port === null) {
      throw new ActioTaskError("Actio is not registered or running in Excubitor", "unavailable");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`http://127.0.0.1:${port}${path}`, {
        method,
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new ActioTaskError("Actio request failed", networkOutcome);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // Drain the response for connection reuse, but never propagate another service's
      // response body into Concordia's database, API, or logs.
      await response.text().catch(() => "");
      const outcome = method === "POST" && response.status === 409
        ? "unknown"
        : response.status >= 500 ? networkOutcome : "rejected";
      throw new ActioTaskError(`Actio ${method} failed: ${response.status}`, outcome);
    }
    return await response.json() as T;
  }
}
