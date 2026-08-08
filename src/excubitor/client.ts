/**
 * Excubitor (サービス監視・起動制御、 既定 127.0.0.1:17332) の HTTP クライアント。
 *
 * Concordia は自分でサービスを起動しない — 起動・停止・再起動は **必ず Excubitor 経由**で
 * 行い、 catalog に登録済みのサービスだけを対象にする (worktree / 複製フォルダからの直接起動は
 * 禁止)。 develop クローンも `<code>-develop` として catalog に登録済みである前提。
 *
 * spec/feature/develop-confirm-flow.md §3。
 */

import { excubitorBaseUrl } from "../config/service-urls.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("excubitor/client");

const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_PROCESS_SNAPSHOT_AGE_MS = 150_000;

export type ServiceAction = "start" | "stop" | "restart";

export interface ExcubitorService {
  code: string;
  name: string;
  port: number | null;
  state: string;
  /**
   * catalog エントリそのもの (cwd / command / runtime 等)。
   *
   * `port` は catalog に宣言された正本。 top-level の `port` は実行時の観測値で、
   * サービスが動いていても null のことがあるため、 ポート解決は
   * `resolveServicePort` (excubitor/service-port.ts) を使って両方を見る。
   */
  catalog_snapshot?: { cwd?: string | null; port?: number | null; provides?: Record<string, string | null> } | null;
}

export interface ControlResult {
  ok: boolean;
  action: ServiceAction;
  exit_code: number | null;
  stdout?: string;
  stderr?: string;
}

export interface ExcubitorProcess {
  pid: number;
  ppid: number;
  rss: number;
  cpu_ms: number | null;
  name: string;
  started_at: number | null;
  command_line: string;
}

export interface ExcubitorProcessSnapshot {
  sampled_at: number;
  processes: ExcubitorProcess[];
}

export interface ExcubitorClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** テスト用の fetch 差し替え。 */
  fetchImpl?: typeof fetch;
}

export class ExcubitorClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ExcubitorClientOptions = {}) {
    this.baseUrl = options.baseUrl
      ? options.baseUrl.replace(/\/+$/, "")
      : excubitorBaseUrl();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listServices(): Promise<ExcubitorService[]> {
    const body = await this.request<{ services: ExcubitorService[] }>("GET", "/api/v1/services");
    return body.services ?? [];
  }

  /** Excubitor が一元採取した全プロセスの最新キャッシュを読む。ローカル WMI/ps は起動しない。 */
  async getProcessSnapshot(timeoutMs = 5_000): Promise<ExcubitorProcessSnapshot> {
    return this.request<ExcubitorProcessSnapshot>("GET", "/api/v1/processes/snapshot", undefined, timeoutMs);
  }

  async findService(code: string): Promise<ExcubitorService | null> {
    try {
      return await this.request<ExcubitorService>("GET", `/api/v1/services/${encodeURIComponent(code)}`);
    } catch (e) {
      if (e instanceof ExcubitorNotFound) return null;
      throw e;
    }
  }

  /** サービスを起動/停止/再起動する。 Excubitor が非 ok を返しても throw せず結果を返す。 */
  async control(code: string, action: ServiceAction): Promise<ControlResult> {
    log.info({ service: code, action }, "excubitor control");
    return this.request<ControlResult>(
      "POST",
      `/api/v1/services/${encodeURIComponent(code)}/control`,
      { action },
    );
  }

  /**
   * 直近の liveness (ok 判定) を返す。 Excubitor の liveness は定期プローブの履歴なので、
   * start 直後は空になりうる (呼び出し側でリトライする)。
   */
  async isAlive(code: string, windowMin = 5): Promise<boolean | null> {
    const body = await this.request<{ series?: Array<{ t: number; ok: number }> }>(
      "GET",
      `/api/v1/services/${encodeURIComponent(code)}/liveness?window_min=${windowMin}`,
    );
    const series = body.series ?? [];
    const last = series[series.length - 1];
    if (!last) return null;
    return last.ok === 1;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          // Excubitor の audit_log に「誰が操作したか」を残す。
          "x-concordia-actor": "concordia",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 404) throw new ExcubitorNotFound(path);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`excubitor ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class ExcubitorNotFound extends Error {
  constructor(path: string) {
    super(`excubitor: not found (${path})`);
    this.name = "ExcubitorNotFound";
  }
}

/** develop クローンで動かすサービスのコード (catalog 登録名)。 */
export function developServiceCode(code: string): string {
  return `${code}-develop`;
}
