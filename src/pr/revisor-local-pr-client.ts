/**
 * Revisor の local PR API クライアント (提出と一覧)。
 *
 * `revisor-client.ts` は旧 GitHub PR gate (`/v1/pr-gate/jobs`) 向けで、 その
 * エンドポイントは Revisor から撤去済み。 現行のレビュー発火は「ローカルブランチを
 * local PR として提出する」経路なので、 それ専用のクライアントとして分ける。
 *
 * 読み取り (`GET`) は Revisor が loopback 限定で token を要求しないが、 提出は変更系
 * なので token が要る。 token が無い環境では提出だけが失敗する (一覧は動く)。
 */

import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import { toTokenResolver } from "./revisor-token.js";
import type { PrSourceLink } from "./session-source-links.js";

const REVISOR_SERVICE_CODE = "revisor";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface RevisorRepositoryRegistration {
  repository: string;
  rootPath: string;
  baseRef: string;
}

export interface RevisorLocalPrSummary {
  id: string;
  number: number;
  repository: string;
  headRef: string;
  status: string;
  checkStatus: string;
  sessionId?: string | null;
  reviewLane?: "standard" | "fast";
}

export interface SubmitLocalPrInput {
  repository: string;
  title: string;
  body: string;
  author: string;
  /**
   * Revisor の終局レビューイベントを戻す Concordia セッション。 session 非依存の
   * direct 提出では無し — その場合 Revisor は session.inject を送らず、 結果は
   * 共有チャット通知 (pr-lifecycle-notice) だけになる。
   */
  sessionId?: string;
  headRef: string;
  baseRef?: string;
  sourceLinks?: readonly PrSourceLink[];
  /** Explicit opt-in only. Omission always means the standard queue. */
  fastLane?: boolean;
}

/** local PR の提出・照会に必要な操作だけを表す最小インタフェース (テスト差し替え用)。 */
export interface RevisorLocalPrGateway {
  listRepositories(): Promise<RevisorRepositoryRegistration[]>;
  listLocalPullRequests(): Promise<RevisorLocalPrSummary[]>;
  submitLocalPullRequest(input: SubmitLocalPrInput): Promise<RevisorLocalPrSummary>;
  retryLocalPullRequest(id: string): Promise<RevisorLocalPrSummary>;
  promoteLocalPullRequest(id: string, sessionId: string): Promise<RevisorLocalPrSummary>;
}

export interface RevisorLocalPrClientOptions {
  excubitor: Pick<ExcubitorClient, "findService">;
  /**
   * 提出 (変更系) に必要。 空なら提出は失敗し、 一覧のみ利用できる。
   * 関数を渡すと **リクエストごとに解決**するので、 Web UI から設定した token が
   * 再起動なしで効く (DB 設定の解決は revisor-config.ts)。
   */
  token?: string | (() => string | undefined);
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function asRepository(value: unknown): RevisorRepositoryRegistration | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.repository !== "string" || typeof row.rootPath !== "string") return null;
  return {
    repository: row.repository,
    rootPath: row.rootPath,
    baseRef: typeof row.baseRef === "string" ? row.baseRef : "main",
  };
}

function asLocalPr(value: unknown): RevisorLocalPrSummary | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.repository !== "string") return null;
  return {
    id: row.id,
    number: typeof row.number === "number" ? row.number : 0,
    repository: row.repository,
    headRef: typeof row.headRef === "string" ? row.headRef : "",
    status: typeof row.status === "string" ? row.status : "",
    checkStatus: typeof row.checkStatus === "string" ? row.checkStatus : "",
    sessionId: typeof row.sessionId === "string" ? row.sessionId : null,
    reviewLane: row.reviewLane === "fast" ? "fast" : "standard",
  };
}

export class RevisorLocalPrClient implements RevisorLocalPrGateway {
  private readonly excubitor: Pick<ExcubitorClient, "findService">;
  private readonly token: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RevisorLocalPrClientOptions) {
    this.excubitor = options.excubitor;
    this.token = toTokenResolver(options.token);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** ポートは Excubitor catalog が正本 (port-source-rule)。 ハードコードしない。 */
  private async resolvePort(): Promise<number> {
    const service = await this.excubitor.findService(REVISOR_SERVICE_CODE);
    // Excubitor の top-level port は実行時の観測値で null のことがある。 catalog が正本。
    const port = resolveServicePort(service);
    if (port === null) {
      throw new Error(`Excubitor service "${REVISOR_SERVICE_CODE}" has no valid port`);
    }
    return port;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const port = await this.resolvePort();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // token は保持せずリクエストごとに解決する (設定変更が再起動なしで効く)。
      const token = this.token();
      const response = await this.fetchImpl(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "x-concordia-actor": "concordia",
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) {
        const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
        throw new Error(`Revisor ${path} failed (${response.status})${detail}`);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async listRepositories(): Promise<RevisorRepositoryRegistration[]> {
    const body = await this.request("/v1/repositories") as { repositories?: unknown } | null;
    if (!Array.isArray(body?.repositories)) {
      throw new Error("Revisor returned an invalid repository listing");
    }
    return body.repositories
      .map(asRepository)
      .filter((row): row is RevisorRepositoryRegistration => row !== null);
  }

  async listLocalPullRequests(): Promise<RevisorLocalPrSummary[]> {
    const body = await this.request("/v1/local-prs") as { pullRequests?: unknown } | null;
    if (!Array.isArray(body?.pullRequests)) {
      throw new Error("Revisor returned an invalid local PR listing");
    }
    return body.pullRequests
      .map(asLocalPr)
      .filter((row): row is RevisorLocalPrSummary => row !== null);
  }

  async submitLocalPullRequest(input: SubmitLocalPrInput): Promise<RevisorLocalPrSummary> {
    const body = await this.request("/v1/local-prs", {
      method: "POST",
      body: JSON.stringify({
        repository: input.repository,
        title: input.title,
        body: input.body,
        author: input.author,
        // Revisor はこの binding を保存し、審査終了時に該当セッションだけへ
        // session.inject を送る。ここで落とすと通知先が無く、投稿者は結果を
        // ポーリングするしかなくなる。direct 提出 (session 無し) だけは意図的に
        // binding を付けず、共有チャット通知に任せる。
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        head_ref: input.headRef,
        ...(input.baseRef ? { base_ref: input.baseRef } : {}),
        ...(input.sourceLinks?.length ? { source_links: input.sourceLinks } : {}),
        ...(input.fastLane === true ? { fast_lane: true } : {}),
      }),
    }) as { pullRequest?: unknown } | null;
    const pullRequest = asLocalPr(body?.pullRequest);
    if (!pullRequest) throw new Error("Revisor returned an invalid local PR");
    return pullRequest;
  }

  async retryLocalPullRequest(id: string): Promise<RevisorLocalPrSummary> {
    const body = await this.request(`/v1/local-prs/${encodeURIComponent(id)}/retry`, {
      method: "POST",
    }) as { pullRequest?: unknown } | null;
    const pullRequest = asLocalPr(body?.pullRequest);
    if (!pullRequest) throw new Error("Revisor returned an invalid retried local PR");
    return pullRequest;
  }

  async promoteLocalPullRequest(id: string, sessionId: string): Promise<RevisorLocalPrSummary> {
    const body = await this.request(`/v1/local-prs/${encodeURIComponent(id)}/fast-lane`, {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId }),
    }) as { pullRequest?: unknown } | null;
    const pullRequest = asLocalPr(body?.pullRequest);
    if (!pullRequest) throw new Error("Revisor returned an invalid promoted local PR");
    return pullRequest;
  }
}

/**
 * token の出所は DB 設定 (revisor_config) だけ。 呼び出し側は `resolveToken` に
 * `() => resolveRevisorWorkflowToken(repo, box)` を渡す (env フォールバックは廃止)。
 */
export function createRevisorLocalPrClient(
  excubitor: Pick<ExcubitorClient, "findService">,
  resolveToken: () => string | undefined,
): RevisorLocalPrClient {
  return new RevisorLocalPrClient({ excubitor, token: resolveToken });
}
