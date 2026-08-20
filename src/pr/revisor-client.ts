import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import { toTokenResolver } from "./revisor-token.js";
import { RevisorMergeError } from "./revisor-merge-outcome.js";

const REVISOR_SERVICE_CODE = "revisor";
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * マージだけ別枠にする。 Revisor のマージは隔離 clone の準備・squash・事前
 * セキュリティスキャン・公開までを 1 リクエストの中で同期実行するので、 読み取りと
 * 同じ 10 秒では日常的に足りない。 2026-08-10 の Peregrinatio#408 では Concordia が
 * 10,020ms / 10,014ms で 2 回打ち切った一方、 Revisor 側はどちらも完走していて、
 * 「失敗した」と報告された変更が実際には main に入っていた。
 *
 * 打ち切り自体は残す — 無期限に待つと呼び出し側 (Discord のマージ操作) が固まる。
 * 打ち切った場合は「失敗」ではなく「結果不明」として扱い、 呼び出し側が PR の実状態を
 * 読み直して確定させる。
 */
const DEFAULT_MERGE_TIMEOUT_MS = 180_000;

export interface RevisorReviewRequest {
  repository: string;
  number: number;
  head_sha: string;
  head_ref: string;
  head_repository: string;
  base_ref: string;
  pull_request_url?: string;
  review_mode: "full" | "verification";
}

export interface RevisorReviewTrigger {
  enqueue(request: RevisorReviewRequest): Promise<{
    id: string;
    status: string;
    check_url?: string;
  }>;
}

/**
 * Revisor の local PR 1 件 (GET /v1/local-prs の pullRequests[])。 Revisor 側は
 * camelCase の JSON をそのまま返すので、 ここでは受け取った形に寄せて型付けする。
 * 未知フィールドは無視する (Revisor の進化で Concordia が落ちないようにする)。
 */
export interface RevisorLocalPr {
  id: string;
  number: number;
  repository: string;
  title: string;
  author: string;
  status: string;
  /** queued | running | test_ok | failed | action_required など。 */
  checkStatus: string;
  draft?: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  reviewedHeadSha?: string | null;
  reviewer?: string | null;
  labels?: string[];
  reasons?: string[];
  advisories?: string[];
  humanQuestion?: string | null;
  createdAt: string;
  updatedAt: string;
  sessionId?: string | null;
  reviewLane?: "standard" | "fast";
}

export interface RevisorLocalPrReader {
  /** Revisor に登録された local PR を新しい順で返す。 */
  listLocalPrs(): Promise<RevisorLocalPr[]>;
  /** Revisor の WebUI を開くための base URL (loopback)。 */
  baseUrl(): Promise<string>;
}

/** Revisor が保持する local PR を明示操作でマージする窓口。 */
export interface RevisorLocalPrMerger {
  mergeLocalPr(id: string): Promise<void>;
}

/**
 * Revisor が保持する local PR を明示操作で取り下げる窓口。
 *
 * マージできない PR には「直せば通る」もの (衝突・テスト失敗) と、「もう出す意味が
 * 無い」もの (内容が既に main に入っており squash しても 0 件) がある。 後者は
 * Revisor 側でも squash が空コミットになって失敗するだけで、 board から消す手段が
 * マージ経路には無い。 取り下げを別の窓口として持たせる。
 */
export interface RevisorLocalPrCloser {
  closeLocalPr(id: string, reason?: string): Promise<void>;
}

/** Revisor の queued local PR を active session の明示指示で fast lane へ移す。 */
export interface RevisorLocalPrPromoter {
  promoteLocalPr(id: string, sessionId: string): Promise<void>;
}

interface RevisorClientOptions {
  excubitor: Pick<ExcubitorClient, "findService">;
  /**
   * 書き込み (enqueue / merge) にだけ必要。 読み取りだけなら省略できる。
   * 関数を渡すと**リクエストごとに解決**する — Revisor は変更系を workflow token
   * 1 本で認可するので、 提出系 (revisor-local-pr-client) と同じ DB 正本
   * (`revisor_config.workflow_token_enc`) を使い回せる。
   */
  token?: string | (() => string | undefined);
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** マージだけの上限。 未指定なら `DEFAULT_MERGE_TIMEOUT_MS`。 */
  mergeTimeoutMs?: number;
}

export class RevisorClient
implements RevisorReviewTrigger, RevisorLocalPrReader, RevisorLocalPrMerger,
  RevisorLocalPrCloser, RevisorLocalPrPromoter {
  private readonly excubitor: Pick<ExcubitorClient, "findService">;
  private readonly token: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly mergeTimeoutMs: number;

  constructor(options: RevisorClientOptions) {
    // 読み取り (local PR 一覧) に token は要らない — Revisor は loopback からの GET に
    // token を要求しない。 読み取り経路へ workflow token を送らない。
    this.excubitor = options.excubitor;
    this.token = toTokenResolver(options.token);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.mergeTimeoutMs = options.mergeTimeoutMs ?? DEFAULT_MERGE_TIMEOUT_MS;
  }

  /**
   * Revisor のポートは Excubitor catalog が正本 (port-source-rule)。 ハードコードしない。
   */
  private async resolvePort(): Promise<number> {
    const service = await this.excubitor.findService(REVISOR_SERVICE_CODE);
    // Excubitor の top-level port は実行時の観測値で null のことがある。 catalog が正本。
    const port = resolveServicePort(service);
    if (port === null) {
      throw new Error(`Excubitor service "${REVISOR_SERVICE_CODE}" has no valid port`);
    }
    return port;
  }

  async baseUrl(): Promise<string> {
    return `http://127.0.0.1:${await this.resolvePort()}`;
  }

  async listLocalPrs(): Promise<RevisorLocalPr[]> {
    const port = await this.resolvePort();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/v1/local-prs`, {
        headers: {
          "x-concordia-actor": "concordia",
        },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as
        | { pullRequests?: unknown; error?: unknown }
        | null;
      if (!response.ok) {
        const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
        throw new Error(`Revisor local PR listing failed (${response.status})${detail}`);
      }
      if (!Array.isArray(body?.pullRequests)) {
        throw new Error("Revisor returned an invalid local PR listing");
      }
      // 同定に必要なフィールドが欠けた行は捨てる (壊れた 1 行で一覧全体を落とさない)。
      // 残りは宣言したフィールドだけを明示的に写す — 欠けたまま返すと status 未設定の PR が
      // WebUI で「クローズ済み」側に落ちたり `undefined → undefined` と描かれる。 未知
      // フィールドは通さない: Revisor 内部の値 (ローカルパス等) を Concordia の API 応答
      // 経由でブラウザへ素通しさせないため。
      return body.pullRequests.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const pr = item as Record<string, unknown>;
        if (typeof pr.id !== "string" || typeof pr.number !== "number" || typeof pr.repository !== "string") {
          return [];
        }
        const text = (key: string, fallback = ""): string =>
          typeof pr[key] === "string" ? pr[key] as string : fallback;
        const optionalText = (key: string): string | null =>
          typeof pr[key] === "string" ? pr[key] as string : null;
        const stringList = (key: string): string[] =>
          Array.isArray(pr[key]) ? (pr[key] as unknown[]).filter((v): v is string => typeof v === "string") : [];
        return [{
          id: pr.id,
          number: pr.number,
          repository: pr.repository,
          title: text("title"),
          author: text("author"),
          // status 不明を open 扱いにはしない (勝手にマージ待ちへ出さない)。
          status: text("status", "unknown"),
          checkStatus: text("checkStatus", "unknown"),
          draft: pr.draft === true,
          headRef: text("headRef"),
          baseRef: text("baseRef"),
          headSha: text("headSha"),
          reviewedHeadSha: optionalText("reviewedHeadSha"),
          reviewer: optionalText("reviewer"),
          labels: stringList("labels"),
          reasons: stringList("reasons"),
          advisories: stringList("advisories"),
          humanQuestion: optionalText("humanQuestion"),
          createdAt: text("createdAt"),
          updatedAt: text("updatedAt"),
          sessionId: optionalText("sessionId"),
          reviewLane: pr.reviewLane === "fast" ? "fast" : "standard",
        }];
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async enqueue(request: RevisorReviewRequest): Promise<{
    id: string;
    status: string;
    check_url?: string;
  }> {
    // 書き込みは token 必須。 空のまま `Bearer ` を送ると Revisor 側の 401 になり、
    // 「秘密が未配布」という本当の理由が呼び出し側のログから消える。
    const token = this.token();
    if (!token) {
      throw new Error("Revisor trigger token is required (workflow token unset)");
    }
    const port = await this.resolvePort();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `http://127.0.0.1:${port}/v1/pr-gate/jobs`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-concordia-actor": "concordia",
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        },
      );
      const body = await response.json().catch(() => null) as {
        id?: unknown;
        status?: unknown;
        check_url?: unknown;
        error?: unknown;
      } | null;
      if (!response.ok) {
        const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
        throw new Error(`Revisor enqueue failed (${response.status})${detail}`);
      }
      if (typeof body?.id !== "string" || typeof body.status !== "string") {
        throw new Error("Revisor returned an invalid enqueue response");
      }
      return {
        id: body.id,
        status: body.status,
        check_url: typeof body.check_url === "string" ? body.check_url : undefined,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async mergeLocalPr(id: string): Promise<void> {
    await this.mutateLocalPr({ id, action: "merge", label: "merge" });
  }

  async closeLocalPr(id: string, reason?: string): Promise<void> {
    await this.mutateLocalPr({
      id,
      action: "close",
      label: "close",
      body: reason ? { reason } : undefined,
    });
  }

  async promoteLocalPr(id: string, sessionId: string): Promise<void> {
    await this.mutateLocalPr({
      id,
      action: "fast-lane",
      label: "fast-lane promotion",
      body: { session_id: sessionId },
    });
  }

  /**
   * local PR の変更系 (merge / close) は Revisor では同じ workflow token 1 本で
   * 認可され、 経路も応答形も同じ。 差分は path と body だけなので 1 本にまとめる。
   */
  private async mutateLocalPr(request: {
    id: string;
    action: "merge" | "close" | "fast-lane";
    label: string;
    body?: Record<string, unknown>;
  }): Promise<void> {
    // token はリクエストごとに解決する (設定画面で入れた workflow token が再起動なしで効く)。
    const token = this.token();
    if (!token) {
      throw new RevisorMergeError(
        `Revisor ${request.label} token is required (workflow token unset)`,
        { status: 401 },
      );
    }
    let port: number;
    try {
      port = await this.resolvePort();
    } catch (error) {
      throw new RevisorMergeError(
        error instanceof Error ? error.message : `Revisor local PR ${request.label} is unreachable`,
      );
    }
    const controller = new AbortController();
    // 打ち切りを自前の旗で覚える。 AbortError は「呼び出し側が打ち切った」以外でも
    // 起き得るので、 error の種類だけで timeout と断定しない。
    let timedOut = false;
    // 上限は操作ごとに分ける。 merge は隔離 clone の準備から公開までを同期実行するが、
    // close は状態を書き替えるだけで短い。
    const deadlineMs = request.action === "merge" ? this.mergeTimeoutMs : this.timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadlineMs);
    try {
      const url = `http://127.0.0.1:${port}/v1/local-prs/${encodeURIComponent(request.id)}/${request.action}`;
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-concordia-actor": "concordia",
          ...(request.body ? { "content-type": "application/json" } : {}),
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) {
        const revisorError = typeof body?.error === "string" ? body.error : null;
        throw new RevisorMergeError(
          `Revisor local PR ${request.label} failed (${response.status})`,
          { status: response.status, revisorError },
        );
      }
    } catch (error) {
      if (error instanceof RevisorMergeError) throw error;
      if (timedOut) {
        throw new RevisorMergeError(
          `Revisor local PR ${request.label} timed out after ${deadlineMs}ms`,
          { timedOut: true },
        );
      }
      // 到達できなかった (接続拒否など)。 status を持たないことが「届いていない」の印。
      throw new RevisorMergeError(
        `Revisor local PR ${request.label} request failed before a response was received`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * token は DB 正本 (revisor_config) の resolver から取る — Revisor は変更系 (merge 含む) を
 * workflow token 1 本で認可するため、 merge 専用トークンは存在しない。
 *
 * 旧 env `CONCORDIA_REVISOR_TOKEN` フォールバックは廃止した。 spawner が子プロセスから
 * この env を削除する一方で resolver を渡さない呼び出し (chat-worker) が残っており、
 * 「設定画面には設定済みと出るのにチャット経由のマージだけ 401」という追いにくい
 * 不整合を生んでいたため。 resolver は必須引数にして、 渡し忘れを型で止める。
 */
export function createRevisorClient(
  excubitor: Pick<ExcubitorClient, "findService">,
  resolveToken: () => string | undefined,
): RevisorClient {
  // token 未設定でもクライアントを作る。 PRs ページの Revisor セクションは読み取りだけで
  // 足り、 Revisor は loopback からの GET に token を要求しない。 null を返していたため
  // 「秘密を配れない」だけでセクションごと出ない (configured=false) 状態になっていた。
  return new RevisorClient({
    excubitor,
    token: () => resolveToken()?.trim() || "",
  });
}
