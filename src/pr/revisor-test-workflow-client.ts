// Revisor Test Workflow の読取クライアント。
// @implements spec/feature/revisor-test-forum-sync.md — Runtime boundary
import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import { toTokenResolver } from "./revisor-token.js";

const REVISOR_SERVICE_CODE = "revisor";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface RevisorTestWorkflowProduct {
  repository: string;
  pullRequestId: string;
  number: number;
  title: string;
  status: "Open / Test OK";
  headRef: string;
  repositoryRootPath: string;
  reviewedHeadSha: string;
  updatedAt: string;
}

/**
 * Test Forum の投稿に載せる PR の詳細と判断事項。 Revisor の
 * `GET /v1/local-prs/:id` (loopback 読み取り) の decision 部分の抜粋。
 */
export interface RevisorLocalPrDetail {
  author: string | null;
  headRef: string | null;
  baseRef: string | null;
  body: string | null;
  decisionLabel: string | null;
  /** 人間の判断が必要な理由 (判断事項)。 */
  blockers: readonly string[];
  riskScore: number | null;
  riskThreshold: number | null;
  riskBandLabel: string | null;
  runtimeVerificationRequired: boolean;
  /** 登録テストの通過数 / 実行数 (skip 除く)。 */
  testsPassed: number | null;
  testsRan: number | null;
  securityStatus: string | null;
  autoMerge: { merged: boolean; reason: string } | null;
}

/**
 * Test Forum に掲載する open な local PR。 審査済み (Test OK) に限らず、
 * Revisor に登録された時点から失敗・判断待ち・審査中も全部載せる。
 */
export interface RevisorOpenLocalPr {
  id: string;
  repository: string;
  number: number;
  title: string;
  headRef: string;
  headSha: string;
  reviewedHeadSha: string | null;
  repositoryRootPath: string;
  checkStatus: string;
  /** 提出元 Concordia セッション。 メンション対象の解決に使う。 */
  sessionId: string | null;
  detail: RevisorLocalPrDetail;
}

export interface RevisorTestWorkflowSource {
  listProducts(): Promise<readonly RevisorTestWorkflowProduct[]>;
  /** open な local PR の全件 (詳細・spawn target 込み)。 Test Forum の候補正本。 */
  listOpenLocalPrs(): Promise<readonly RevisorOpenLocalPr[]>;
  /**
   * 単一 PR の詳細。 取得や解析に失敗しても同期全体は止めない前提の
   * 追加情報なので、 呼出側は失敗を null として扱ってよい (throw はする)。
   */
  getProductDetail(pullRequestId: string): Promise<RevisorLocalPrDetail>;
}

export interface RevisorTestWorkflowClientOptions {
  excubitor: Pick<ExcubitorClient, "findService">;
  /**
   * 読み取りは loopback 限定で token 不要。 設定されている場合だけ Bearer を送る。
   * 関数を渡すとリクエストごとに解決する (設定変更が再起動なしで効く)。
   */
  token?: string | (() => string | undefined);
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface RevisorTestWorkflowProjection {
  repository: string;
  pullRequestId: string;
  number: number;
  title: string;
  status: "Open / Test OK";
  reviewedHeadSha: string;
  updatedAt: string;
}

function isProjection(value: unknown): value is RevisorTestWorkflowProjection {
  if (!value || typeof value !== "object") return false;
  const product = value as Record<string, unknown>;
  return typeof product.repository === "string"
    && product.repository.trim().length > 0
    && typeof product.pullRequestId === "string"
    && product.pullRequestId.trim().length > 0
    && typeof product.number === "number"
    && Number.isInteger(product.number)
    && product.number > 0
    && typeof product.title === "string"
    && product.status === "Open / Test OK"
    && typeof product.reviewedHeadSha === "string"
    && product.reviewedHeadSha.trim().length > 0
    && typeof product.updatedAt === "string";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export class RevisorTestWorkflowClient implements RevisorTestWorkflowSource {
  private readonly excubitor: Pick<ExcubitorClient, "findService">;
  private readonly token: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RevisorTestWorkflowClientOptions) {
    // Revisor は loopback からの読み取りに token を要求しない (変更系のみ要求する)。
    // token は「あれば送る」扱いにして、 設定が無いだけで一覧取得が止まらないようにする。
    this.excubitor = options.excubitor;
    this.token = toTokenResolver(options.token);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listProducts(): Promise<readonly RevisorTestWorkflowProduct[]> {
    const [workflowBody, prsBody, repositoriesBody] = await Promise.all([
      this.getJson("/v1/test-workflow"),
      this.getJson("/v1/local-prs"),
      this.getJson("/v1/repositories"),
    ]) as Array<Record<string, unknown> | null>;
    const rawProducts = workflowBody?.products;
    const pullRequests = prsBody?.pullRequests;
    const repositories = repositoriesBody?.repositories;
    if (
      !Array.isArray(rawProducts)
      || !Array.isArray(pullRequests)
      || !Array.isArray(repositories)
    ) {
      throw new Error("Revisor returned an invalid test workflow response");
    }
    // Revisor は early QA (feat 697a730) で審査中の行 (Open / In Review,
    // reviewedHeadSha null) も返すようになった。 listProducts の意味は
    // 「Test OK のプロダクト」なので、 早期 QA 行は捨てて Test OK だけを検証する。
    const products = rawProducts.filter((value) =>
      !!value && typeof value === "object"
      && (value as Record<string, unknown>).status === "Open / Test OK");
    if (!products.every(isProjection)) {
      throw new Error("Revisor returned an invalid test workflow response");
    }
    return products.map((product) => {
      const pullRequest = pullRequests.find((value) => {
        if (!value || typeof value !== "object") return false;
        const candidate = value as Record<string, unknown>;
        return candidate.id === product.pullRequestId
          && candidate.repository === product.repository;
      }) as Record<string, unknown> | undefined;
      const repository = repositories.find((value) => {
        if (!value || typeof value !== "object") return false;
        return (value as Record<string, unknown>).repository === product.repository;
      }) as Record<string, unknown> | undefined;
      if (!nonEmptyString(pullRequest?.headRef) || !nonEmptyString(repository?.rootPath)) {
        throw new Error(`Revisor omitted the spawn target for ${product.repository}#${product.number}`);
      }
      return {
        ...product,
        headRef: pullRequest.headRef,
        repositoryRootPath: repository.rootPath,
      };
    });
  }

  async listOpenLocalPrs(): Promise<readonly RevisorOpenLocalPr[]> {
    const [prsBody, repositoriesBody] = await Promise.all([
      this.getJson("/v1/local-prs"),
      this.getJson("/v1/repositories"),
    ]) as Array<Record<string, unknown> | null>;
    const rows = prsBody?.pullRequests;
    const repositories = repositoriesBody?.repositories;
    if (!Array.isArray(rows) || !Array.isArray(repositories)) {
      throw new Error("Revisor returned an invalid local PR list response");
    }
    const rootPaths = new Map<string, string>();
    for (const value of repositories) {
      if (!value || typeof value !== "object") continue;
      const repository = value as Record<string, unknown>;
      if (nonEmptyString(repository.repository) && nonEmptyString(repository.rootPath)) {
        rootPaths.set(repository.repository, repository.rootPath);
      }
    }
    const open: RevisorOpenLocalPr[] = [];
    for (const row of rows) {
      const parsed = parseOpenLocalPr(row, rootPaths);
      if (parsed) open.push(parsed);
    }
    return open;
  }

  async getProductDetail(pullRequestId: string): Promise<RevisorLocalPrDetail> {
    const body = await this.getJson(
      `/v1/local-prs/${encodeURIComponent(pullRequestId)}`,
    ) as { pullRequest?: unknown } | null;
    const detail = parseLocalPrDetail(body?.pullRequest);
    if (!detail) {
      throw new Error("Revisor returned an invalid local PR detail response");
    }
    return detail;
  }

  private async getJson(path: string): Promise<unknown> {
    const service = await this.excubitor.findService(REVISOR_SERVICE_CODE);
    // Excubitor の top-level port は実行時の観測値で null のことがある。 catalog が正本。
    const port = resolveServicePort(service);
    if (port === null) {
      throw new Error(`Excubitor service "${REVISOR_SERVICE_CODE}" has no valid port`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // token は保持せずリクエストごとに解決する (設定変更が再起動なしで効く)。
      // resolver は DB を読むので throw しうる。 try の中で呼び、 timer を必ず片付ける。
      const token = this.token();
      const response = await this.fetchImpl(
        `http://127.0.0.1:${port}${path}`,
        {
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            "x-concordia-actor": "concordia",
          },
          signal: controller.signal,
        },
      );
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) {
        const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
        throw new Error(`Revisor test workflow request failed (${response.status})${detail}`);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * open 行だけを掲載候補にする。 骨格 (id/repository/番号/head/rootPath) が欠けた行は
 * 候補から外す (null)。 detail の欠落フィールドは parseLocalPrDetail が null へ落とす。
 */
function parseOpenLocalPr(
  value: unknown,
  rootPaths: ReadonlyMap<string, string>,
): RevisorOpenLocalPr | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.status !== "open") return null;
  const rootPath = typeof row.repository === "string" ? rootPaths.get(row.repository) : undefined;
  if (
    !nonEmptyString(row.id)
    || !nonEmptyString(row.repository)
    || typeof row.number !== "number" || !Number.isInteger(row.number)
    || typeof row.title !== "string"
    || !nonEmptyString(row.headRef)
    || !nonEmptyString(row.headSha)
    || !nonEmptyString(row.checkStatus)
    || !rootPath
  ) {
    return null;
  }
  const detail = parseLocalPrDetail(row);
  if (!detail) return null;
  return {
    id: row.id,
    repository: row.repository,
    number: row.number,
    title: row.title,
    headRef: row.headRef,
    headSha: row.headSha,
    reviewedHeadSha: nonEmptyString(row.reviewedHeadSha) ? row.reviewedHeadSha : null,
    repositoryRootPath: rootPath,
    checkStatus: row.checkStatus,
    sessionId: nonEmptyString(row.sessionId) ? row.sessionId : null,
    detail,
  };
}

/**
 * decision まわりだけを抜粋する寛容なパーサ。 Revisor 側のフィールド追加で
 * 同期を止めないため、 個々の欠落は null に落とす。 ただし PR の骨格
 * (object であること) すら無い場合は null を返し、 呼出側が fail-fast する。
 */
export function parseLocalPrDetail(value: unknown): RevisorLocalPrDetail | null {
  if (!value || typeof value !== "object") return null;
  const pr = value as Record<string, unknown>;
  const decision = (pr.decision && typeof pr.decision === "object"
    ? pr.decision
    : {}) as Record<string, unknown>;
  const blockers = Array.isArray(decision.blockers)
    ? decision.blockers.filter((item): item is string => typeof item === "string")
    : [];
  const ci = Array.isArray(pr.ci) ? pr.ci as Array<Record<string, unknown>> : null;
  const skipped = ci?.filter((entry) => entry.status === "skipped").length ?? 0;
  const security = (pr.security && typeof pr.security === "object"
    ? pr.security
    : null) as Record<string, unknown> | null;
  const autoMerge = (pr.autoMerge && typeof pr.autoMerge === "object"
    ? pr.autoMerge
    : null) as Record<string, unknown> | null;
  return {
    author: asStringOrNull(pr.author),
    headRef: asStringOrNull(pr.headRef),
    baseRef: asStringOrNull(pr.baseRef),
    body: asStringOrNull(pr.body),
    decisionLabel: asStringOrNull(decision.label),
    blockers,
    riskScore: asNumberOrNull(decision.riskScore),
    riskThreshold: asNumberOrNull(decision.riskThreshold),
    riskBandLabel: asStringOrNull(decision.riskBandLabel),
    runtimeVerificationRequired: decision.runtimeVerificationRequired === true,
    testsPassed: ci ? ci.filter((entry) => entry.status === "passed").length : null,
    testsRan: ci ? ci.length - skipped : null,
    securityStatus: security ? asStringOrNull(security.status) : null,
    autoMerge: autoMerge && typeof autoMerge.merged === "boolean"
      ? { merged: autoMerge.merged, reason: asStringOrNull(autoMerge.reason) ?? "" }
      : null,
  };
}

export function createRevisorTestWorkflowClientFromEnv(
  excubitor: Pick<ExcubitorClient, "findService">,
  env: NodeJS.ProcessEnv = process.env,
): RevisorTestWorkflowClient {
  // Revisor の読み取りは loopback 限定で token 不要なので、 未設定でもクライアントを作る。
  // これが null を返していたため、 token を配れないだけで Test Forum 同期が
  // 「Revisor Test Workflow source unavailable」で永久にスキップされていた。
  // trim は constructor 側で行う。
  return new RevisorTestWorkflowClient({
    excubitor,
    token: env.CONCORDIA_REVISOR_WORKFLOW_TOKEN,
  });
}

/**
 * DB 設定 (revisor_config) 込みで token を解決するクライアント。
 * `resolveToken` はリクエストごとに呼ばれるので、 Web UI での変更が再起動なしで効く。
 */
export function createRevisorTestWorkflowClient(
  excubitor: Pick<ExcubitorClient, "findService">,
  resolveToken: () => string | undefined,
  // fetch / timeout はテストから差し替えられるようにしておく (省略時は既定)。
  overrides: Pick<RevisorTestWorkflowClientOptions, "fetchImpl" | "timeoutMs"> = {},
): RevisorTestWorkflowClient {
  return new RevisorTestWorkflowClient({ excubitor, token: resolveToken, ...overrides });
}
