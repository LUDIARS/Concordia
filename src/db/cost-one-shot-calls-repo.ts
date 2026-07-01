import type Database from "better-sqlite3";

export type CostOneShotStatus = "ok" | "error" | "timeout" | "unknown";

export interface CostOneShotInput {
  ts?: number;
  service: string;
  provider: string;
  command?: string;
  model?: string | null;
  cwd?: string | null;
  prompt: string;
  status?: CostOneShotStatus;
  exit_code?: number | null;
  duration_ms?: number | null;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  metadata_json?: string;
}

export interface CostOneShotRow extends Required<Omit<CostOneShotInput, "ts" | "model" | "cwd" | "exit_code" | "duration_ms">> {
  id: number;
  ts: number;
  model: string | null;
  cwd: string | null;
  exit_code: number | null;
  duration_ms: number | null;
}

export interface CostOneShotSummaryRow {
  service: string;
  provider: string;
  calls: number;
  ok_calls: number;
  error_calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  last_ts: number;
}

function clampInt(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback;
}

function optionalInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null;
}

function statusOf(v: unknown): CostOneShotStatus {
  return v === "ok" || v === "error" || v === "timeout" ? v : "unknown";
}

export class CostOneShotCallsRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: CostOneShotInput): number {
    const service = input.service.trim();
    const provider = input.provider.trim();
    if (!service) throw new Error("service required");
    if (!provider) throw new Error("provider required");

    const total = input.total_tokens ?? ((input.input_tokens ?? 0) + (input.output_tokens ?? 0));
    const r = this.db
      .prepare(
        `INSERT INTO cost_one_shot_calls
          (ts, service, provider, command, model, cwd, prompt, status, exit_code, duration_ms,
           input_tokens, output_tokens, total_tokens, cost_usd, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        clampInt(input.ts, Date.now()),
        service,
        provider,
        input.command?.trim() ?? "",
        input.model ?? null,
        input.cwd ?? null,
        input.prompt,
        statusOf(input.status),
        optionalInt(input.exit_code),
        optionalInt(input.duration_ms),
        clampInt(input.input_tokens),
        clampInt(input.output_tokens),
        clampInt(total),
        typeof input.cost_usd === "number" && Number.isFinite(input.cost_usd) ? input.cost_usd : 0,
        input.metadata_json ?? "{}",
      );
    return Number(r.lastInsertRowid);
  }

  listRecent(limit = 100): CostOneShotRow[] {
    const n = Math.max(1, Math.min(500, Math.floor(limit)));
    return this.db
      .prepare(
        `SELECT id, ts, service, provider, command, model, cwd, prompt, status, exit_code, duration_ms,
                input_tokens, output_tokens, total_tokens, cost_usd, metadata_json
           FROM cost_one_shot_calls
          ORDER BY ts DESC, id DESC
          LIMIT ?`,
      )
      .all(n) as CostOneShotRow[];
  }

  summarySince(sinceMs: number): CostOneShotSummaryRow[] {
    return this.db
      .prepare(
        `SELECT service, provider,
                COUNT(*) AS calls,
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_calls,
                SUM(CASE WHEN status IN ('error', 'timeout') THEN 1 ELSE 0 END) AS error_calls,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(total_tokens) AS total_tokens,
                SUM(cost_usd) AS cost_usd,
                MAX(ts) AS last_ts
           FROM cost_one_shot_calls
          WHERE ts >= ?
          GROUP BY service, provider
          ORDER BY cost_usd DESC, total_tokens DESC, calls DESC`,
      )
      .all(Math.floor(sinceMs)) as CostOneShotSummaryRow[];
  }
}
