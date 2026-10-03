/** Fresh official app-server model/list adapter; subscription credentials stay with Codex. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { OfficialModelProviderPort } from "./refresh.js";
import type { ProviderModel } from "./role-policy.js";

export function codexOfficialModelProvider(input: { executable: string; prefixArgs?:string[]; cwd: string; now?: () => number }): OfficialModelProviderPort {
  if (!input.executable.trim()) throw new Error("codex_executable_required");
  return { async discover(signal) {
    if (signal.aborted) throw new Error("model_discovery_aborted");
    const child = spawn(input.executable, [...(input.prefixArgs ?? []),"app-server"], { cwd: input.cwd, shell: false,
      stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    let sequence = 0;
    let closed = false;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    const fail = (error: Error): void => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
    child.stdin.on("error", () => fail(new Error("codex_stdin_failed")));
    child.stdout.on("error", () => fail(new Error("codex_stdout_failed")));
    lines.on("error", () => fail(new Error("codex_reader_failed")));
    child.on("error", () => fail(new Error("codex_app_server_unavailable")));
    child.on("exit", () => { closed = true; fail(new Error("codex_app_server_closed")); });
    lines.on("line", (line) => {
      if (Buffer.byteLength(line, "utf8") > 1_000_000) { fail(new Error("model_response_limit")); child.kill(); return; }
      let frame: { id?: number; result?: unknown; error?: unknown };
      try { frame = JSON.parse(line) as typeof frame; }
      catch { fail(new Error("model_response_invalid_json")); return; }
      if (typeof frame.id !== "number") return;
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      if (frame.error) waiter.reject(new Error("codex_model_list_rejected"));
      else waiter.resolve(frame.result);
    });
    const abort = (): void => { fail(new Error("model_discovery_aborted")); child.kill(); };
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 55_000);
    const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
      if (closed || signal.aborted) { reject(new Error("codex_app_server_closed")); return; }
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (error) { pending.delete(id); reject(new Error("codex_request_write_failed")); }
      });
    });
    try {
      await request("initialize", { clientInfo: { name: "concordia-model-catalog", version: "1.0.0" } });
      child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
      const models: ProviderModel[] = [];
      let cursor: string | null = null;
      const cursors = new Set<string>();
      for (let page = 0; page < 10; page++) {
        const raw = await request("model/list", { limit: 100, cursor, includeHidden: false });
        const result = raw as { data?: unknown; nextCursor?: unknown } | null;
        if (!result || !Array.isArray(result.data) || result.data.length > 100) throw new Error("model_page_invalid");
        for (const value of result.data) models.push(parseOfficialModel(value));
        if (result.nextCursor == null) return { models, source: "codex:model/list:v1",
          observedAt: new Date((input.now ?? Date.now)()).toISOString() };
        if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor)) throw new Error("model_cursor_invalid");
        cursors.add(result.nextCursor); cursor = result.nextCursor;
      }
      throw new Error("model_page_limit");
    } finally {
      clearTimeout(timeout); signal.removeEventListener("abort", abort);
      fail(new Error("model_discovery_finished")); lines.close(); child.stdin.destroy();
      // This adapter owns only its short lived app-server, never an executing agent.
      if (!closed) child.kill();
    }
  } };
}
export function parseOfficialModel(value: unknown): ProviderModel {
  if (!value || typeof value !== "object") throw new Error("model_record_invalid");
  const row = value as Record<string, unknown>;
  if (typeof row.model !== "string" || !row.model || row.model.length > 120
    || typeof row.hidden !== "boolean" || !Array.isArray(row.supportedReasoningEfforts)
    || !Array.isArray(row.inputModalities) || (row.upgrade != null && typeof row.upgrade !== "string")) throw new Error("model_record_invalid");
  const reasoningEfforts = row.supportedReasoningEfforts.map((value: unknown) => {
    const effort = value && typeof value === "object" ? (value as Record<string, unknown>).reasoningEffort : null;
    if (typeof effort !== "string") throw new Error("model_effort_invalid");
    return effort;
  });
  if (!row.inputModalities.every((value: unknown) => typeof value === "string")) throw new Error("model_modality_invalid");
  return { modelId: row.model, hidden: row.hidden, upgrade: typeof row.upgrade === "string" ? row.upgrade : null,
    capabilities: { reasoningEfforts, inputModalities: row.inputModalities as string[] } };
}
