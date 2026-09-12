/**
 * Revisor の `GET /v1/service-versions` を代理で叩く。
 *
 * 版の正本は Revisor 側にある — 走っているプロセスが名乗る版 (health)、 ディスクの版
 * (package.json)、 リリース版 (`.revisor-version`) のどれも Revisor が見る。 Cc は
 * 「誰に聞くか」 を決めて中継するだけで、 版そのものを別経路で組み立てない。 2 か所で
 * 組み立てると食い違ったときにどちらが正しいか決められない。
 */

import type { RevisorClient } from "../pr/revisor-client.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface RunningVersion {
  reachable: boolean;
  version: string | null;
  error: string | null;
}

export interface ServiceVersion {
  service: string;
  name: string | null;
  repository: string | null;
  port: number | null;
  version: string | null;
  running: RunningVersion;
  packageVersion: string | null;
  releaseVersion: string | null;
  releaseStatus: string | null;
}

export interface ServiceVersionResult {
  requested: string;
  found: boolean;
  services: ServiceVersion[];
}

export interface ServiceVersionReader {
  versions(services: readonly string[]): Promise<ServiceVersionResult[]>;
}

function text(source: Record<string, unknown>, key: string): string | null {
  return typeof source[key] === "string" ? source[key] as string : null;
}

function integer(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function running(value: unknown): RunningVersion {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    reachable: source.reachable === true,
    version: text(source, "version"),
    error: text(source, "error"),
  };
}

/**
 * Revisor が返した行を宣言したフィールドだけに写す。 未知フィールドを通さないのは
 * local PR 一覧と同じ理由 — Revisor 内部の値 (ローカルパス等) を Cc の API 応答経由で
 * ブラウザへ素通しさせないため。
 */
function service(value: unknown): ServiceVersion | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const code = text(source, "service");
  if (!code) return null;
  return {
    service: code,
    name: text(source, "name"),
    repository: text(source, "repository"),
    port: integer(source, "port"),
    version: text(source, "version"),
    running: running(source.running),
    packageVersion: text(source, "packageVersion"),
    releaseVersion: text(source, "releaseVersion"),
    releaseStatus: text(source, "releaseStatus"),
  };
}

export class RevisorServiceVersionsClient implements ServiceVersionReader {
  private readonly revisor: Pick<RevisorClient, "baseUrl">;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: {
    revisor: Pick<RevisorClient, "baseUrl">;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.revisor = options.revisor;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async versions(services: readonly string[]): Promise<ServiceVersionResult[]> {
    if (services.length === 0) throw new Error("At least one service must be named");
    const url = new URL("/v1/service-versions", await this.revisor.baseUrl());
    for (const name of services) url.searchParams.append("service", name);
    const response = await this.fetchImpl(url.toString(), {
      headers: { "x-concordia-actor": "concordia" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.json().catch(() => null) as
      | { versions?: unknown; error?: unknown }
      | null;
    if (!response.ok) {
      const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
      throw new Error(`Revisor service versions failed (${response.status})${detail}`);
    }
    if (!Array.isArray(body?.versions)) {
      throw new Error("Revisor returned an invalid service version listing");
    }
    return body.versions.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const source = item as Record<string, unknown>;
      const requested = text(source, "requested");
      if (!requested) return [];
      const rows = Array.isArray(source.services) ? source.services : [];
      return [{
        requested,
        found: source.found === true,
        services: rows.map(service).filter((row): row is ServiceVersion => row !== null),
      }];
    });
  }
}
