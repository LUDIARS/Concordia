/**
 * Revisor の接続先ポート解決 (SPEC-REVISOR-ENDPOINT-FALLBACK)。
 *
 * 正本は Excubitor (port-source-rule)。 ただし Excubitor が再起動中・無応答だと照会が
 * 素の `fetch failed` で落ち、 Revisor が稼働していても local PR 提出が止まっていた
 * (Actio fa7d0d67)。 照会に失敗したときだけ「直近に解決したポート (TTL 内)」→
 * 「Revisor catalog の宣言ポート」を候補にし、 `/health` が Revisor 自身を名乗る候補
 * だけを採用する。 どれも駄目なら Revisor へは送らずに lookup_failed で止める。
 */

import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import { RevisorRequestError } from "./revisor-http.js";

const REVISOR_SERVICE_CODE = "revisor";
export const REMEMBERED_PORT_TTL_MS = 30 * 60_000;
const HEALTH_TIMEOUT_MS = 2_000;

export interface RememberedPort {
  port: number;
  at: number;
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

export interface FallbackCandidateInput {
  remembered: RememberedPort | null;
  declared: number | null;
  now: number;
  ttlMs?: number;
}

/**
 * 照会失敗時に試すポート候補 (直近ポート → catalog 宣言ポート)。
 * 期限切れ・不正値・重複は除く。
 *
 * @implements SPEC-REVISOR-ENDPOINT-FALLBACK
 */
export function revisorFallbackCandidates(input: FallbackCandidateInput): number[] {
  const ttlMs = input.ttlMs ?? REMEMBERED_PORT_TTL_MS;
  const candidates: number[] = [];
  const remembered = input.remembered;
  if (remembered && validPort(remembered.port) && input.now - remembered.at <= ttlMs && input.now >= remembered.at) {
    candidates.push(remembered.port);
  }
  if (validPort(input.declared) && !candidates.includes(input.declared)) {
    candidates.push(input.declared);
  }
  return candidates;
}

/**
 * Revisor の `/health` 応答か (`{ ok: true, service: "revisor" }`)。 別サービスが同じ
 * ポートで待ち受けていても採用しない。
 *
 * @implements SPEC-REVISOR-ENDPOINT-FALLBACK
 */
export function isRevisorHealth(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const row = body as { ok?: unknown; service?: unknown };
  return row.service === REVISOR_SERVICE_CODE && row.ok === true;
}

export interface RevisorEndpointResolverOptions {
  excubitor: Pick<ExcubitorClient, "findService">;
  /** Revisor catalog の宣言ポート。 未指定なら宣言ポート候補を使わない。 */
  declaredPort?: () => Promise<number | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  healthTimeoutMs?: number;
}

export class RevisorEndpointResolver {
  private readonly excubitor: Pick<ExcubitorClient, "findService">;
  private readonly declaredPort: () => Promise<number | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly healthTimeoutMs: number;
  private remembered: RememberedPort | null = null;

  constructor(options: RevisorEndpointResolverOptions) {
    this.excubitor = options.excubitor;
    this.declaredPort = options.declaredPort ?? (async () => null);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? REMEMBERED_PORT_TTL_MS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  }

  /** @implements SPEC-REVISOR-ENDPOINT-FALLBACK */
  async resolvePort(): Promise<number> {
    let lookupState: string;
    try {
      const port = resolveServicePort(await this.excubitor.findService(REVISOR_SERVICE_CODE));
      if (port !== null) {
        this.remembered = { port, at: this.now() };
        return port;
      }
      lookupState = "Excubitor has no valid port for revisor";
    } catch {
      // 例外本文 (fetch failed / ECONNREFUSED) は載せない。 結果不明の通信失敗と誤認させないため。
      lookupState = "Excubitor lookup failed";
    }
    const candidates = revisorFallbackCandidates({
      remembered: this.remembered,
      declared: await this.safeDeclaredPort(),
      now: this.now(),
      ttlMs: this.ttlMs,
    });
    for (const port of candidates) {
      if (await this.answersAsRevisor(port)) return port;
    }
    throw new RevisorRequestError(
      `Revisor endpoint could not be resolved (${lookupState}; ${candidates.length} fallback candidate(s) did not answer as Revisor). The request was not sent to Revisor`,
      "lookup_failed",
    );
  }

  private async safeDeclaredPort(): Promise<number | null> {
    try {
      return await this.declaredPort();
    } catch {
      return null;
    }
  }

  private async answersAsRevisor(port: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
      if (!response.ok) return false;
      return isRevisorHealth(await response.json());
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
