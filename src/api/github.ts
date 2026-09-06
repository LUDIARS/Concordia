/**
 * GitHub Issue ワークフローの HTTP 面。
 *
 * webhook は署名だけで認可する (ここだけは他の API と違って外から叩かれる)。
 * 一覧と retry は運用面。
 *
 * @implements spec/feature/github-issue-workflow.md — 操作面
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { createChildLogger } from "../shared/logger.js";
import {
  GITHUB_ISSUE_RUN_TERMINAL,
  GITHUB_ISSUE_RUN_STATUSES,
  type GithubIssueRunStatus,
  type GithubIssueRunsRepo,
} from "../db/github-issue-runs-repo.js";
import type { GithubWorkflowConfig } from "../github/config.js";
import { claimedRepository, classifyIssueEvent } from "../github/issue-event.js";
import { verifyGithubSignature } from "../github/signature.js";
import { dispatchIssueTrigger, startIssueFix, type GithubDispatchDeps } from "../github/dispatch.js";
import { approvalRejectedComment } from "../github/text.js";
import { workflowDisabledBody, WORKFLOW_DISABLED_STATUS } from "../workflow/api-gate.js";

const log = createChildLogger("github-webhook");
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/** 却下は理由を必須にする (何も言わずに閉じない — その文面が Issue へ返る)。 */
const RejectSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
}).strict();

const ListQuery = z.object({
  status: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export interface GithubRouterDeps {
  runs: GithubIssueRunsRepo;
  config: GithubWorkflowConfig;
  dispatch: GithubDispatchDeps;
  /** 同じ delivery を 2 度処理しないための記録。 新規なら true。 */
  markDelivery: (deliveryId: string, event: string) => boolean;
  /** retry で使う: 台帳から消したあと Issue を拾い直す。 */
  pollOnce: () => Promise<{ scanned: number; dispatched: number }>;
  /** 外部入力からの起動と retry を、workflow toggle でも fail-closed にする。 */
  isEnabled: () => boolean;
}

export function githubRouter(deps: GithubRouterDeps): Hono {
  const app = new Hono();

  app.use("/webhook", bodyLimit({
    maxSize: MAX_WEBHOOK_BODY_BYTES,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }));

  app.post("/webhook", async (c) => {
    // 署名は生のバイト列に対して計算されている。 JSON へ通したあとに再直列化すると
    // 一致しないので、 必ず生本文で検証する。
    const body = await c.req.text();
    // 検証に使う secret を選ぶためだけに、 先に repo の名乗りを読む。 payload の中身は
    // まだ一切信用していない — 嘘の名乗りはその repo の secret で署名が合わず落ちる。
    // 共通 secret 1 本のままだと、 opt-in している別リポの webhook 設定を見られる相手が
    // 他プロジェクトになりすませた (2026-09-06 neco 指摘)。
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      parsed = null;
    }
    const claimedRepo = claimedRepository(parsed);
    let secret: string | null;
    try {
      secret = (claimedRepo ? deps.config.repoWebhookSecret(claimedRepo) : null)
        ?? deps.config.webhookSecret();
    } catch {
      log.warn("github webhook rejected: secret store is unavailable");
      return c.json({ error: "webhook_secret_unavailable" }, 503);
    }
    const verdict = verifyGithubSignature({
      secret,
      header: c.req.header("x-hub-signature-256"),
      body,
    });
    if (!verdict.ok) {
      if (verdict.reason === "secret_unset") {
        log.warn("github webhook rejected: secret is not configured");
        return c.json({ error: "webhook_secret_unset" }, 503);
      }
      log.warn(`github webhook rejected: ${verdict.reason}`);
      return c.json({ error: "invalid_signature" }, 401);
    }
    // toggle の状態は署名を通った相手にだけ見せる。無署名リクエストへ運用設定を
    // 開示せず、それでも OFF の間は delegation を確実に止める。
    if (!deps.isEnabled()) {
      return c.json(workflowDisabledBody("github"), WORKFLOW_DISABLED_STATUS);
    }

    const event = c.req.header("x-github-event") ?? null;
    const delivery = c.req.header("x-github-delivery")?.trim();
    // ping は GitHub 側の疎通確認。 署名を通ったことだけ返す。
    if (event === "ping") return c.json({ ok: true, pong: true });
    if (!delivery) return c.json({ error: "missing_delivery_id" }, 400);
    if (!deps.markDelivery(delivery, event ?? "unknown")) {
      return c.json({ ok: true, duplicate: true });
    }

    // 署名検証の前に一度だけ parse している。 壊れた JSON は署名が通っていても進めない。
    if (parsed === null) return c.json({ error: "invalid_json" }, 400);
    const payload: unknown = parsed;

    const classification = classifyIssueEvent({ event, payload, label: deps.config.label() });
    if (classification.kind === "ignored") {
      return c.json({ ok: true, ignored: classification.reason });
    }

    const outcome = await dispatchIssueTrigger(deps.dispatch, classification.trigger);
    // 拒否も 202 で返す。 GitHub 側の配送を失敗扱いにして再送させても結果は変わらない。
    return c.json({ ok: true, outcome: outcome.kind }, 202);
  });

  app.get("/issue-runs", (c) => {
    const parsed = ListQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_query", detail: parsed.error.flatten() }, 400);
    const requestedStatuses = parsed.data.status
      ?.split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "");
    if (requestedStatuses?.some(
      (value) => !(GITHUB_ISSUE_RUN_STATUSES as readonly string[]).includes(value),
    )) {
      return c.json({ error: "invalid_status" }, 400);
    }
    const statuses = requestedStatuses as GithubIssueRunStatus[] | undefined;
    return c.json({ runs: deps.runs.list({ statuses, limit: parsed.data.limit }) });
  });

  /**
   * 承認して実行する。 信頼実行者でない相手の Issue を人間が見て通す唯一の口。
   * @implements spec/feature/github-issue-workflow.md — 承認
   */
  app.post("/issue-runs/:id/approve", async (c) => {
    if (!deps.isEnabled()) {
      return c.json(workflowDisabledBody("github"), WORKFLOW_DISABLED_STATUS);
    }
    const run = deps.runs.find(c.req.param("id"));
    if (!run) return c.json({ error: "not_found" }, 404);
    if (run.status !== "awaiting_approval") {
      return c.json({ error: "run_not_awaiting_approval", status: run.status }, 409);
    }
    // 承認時点の opt-in を見る。 承認待ちの間にプロジェクトが外されていたら通さない。
    const project = deps.dispatch.projects.list()
      .find((row) => row.code === run.project_code && row.github_issue_workflow === 1);
    if (!project) return c.json({ error: "project_opted_out" }, 409);
    // 外部の invoke を始める前に同期 CAS でこの承認を確保する。 二重クリックや複数画面からの
    // 同時承認が同じ Issue の delegation を 2 本起動しないようにする。
    const claimed = deps.runs.updateIfStatus(run.id, "awaiting_approval", {
      status: "queued",
      detail: null,
    });
    if (!claimed) {
      return c.json({
        error: "run_not_awaiting_approval",
        status: deps.runs.find(run.id)?.status ?? "not_found",
      }, 409);
    }
    const outcome = await startIssueFix(deps.dispatch, claimed, project.project);
    return c.json({ ok: outcome.kind === "dispatched", outcome: outcome.kind, run: deps.runs.find(run.id) });
  });

  /** 承認せずに閉じる。 理由は公開禁止情報を伏せて Issue へ返す。 */
  app.post("/issue-runs/:id/reject", async (c) => {
    const run = deps.runs.find(c.req.param("id"));
    if (!run) return c.json({ error: "not_found" }, 404);
    if (run.status !== "awaiting_approval") {
      return c.json({ error: "run_not_awaiting_approval", status: run.status }, 409);
    }
    const parsed = RejectSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const rejected = deps.runs.updateIfStatus(run.id, "awaiting_approval", {
      status: "skipped",
      detail: parsed.data.reason,
    });
    if (!rejected) {
      return c.json({
        error: "run_not_awaiting_approval",
        status: deps.runs.find(run.id)?.status ?? "not_found",
      }, 409);
    }
    await deps.dispatch.github.commentOnIssue(
      run.repo_origin,
      run.issue_number,
      approvalRejectedComment(parsed.data.reason),
    ).catch((error: unknown) => {
      log.warn({ run_id: run.id, error_type: error instanceof Error ? error.name : typeof error },
        "github issue rejection comment failed");
    });
    return c.json({ ok: true, run: rejected });
  });

  app.post("/issue-runs/:id/retry", async (c) => {
    if (!deps.isEnabled()) {
      return c.json(workflowDisabledBody("github"), WORKFLOW_DISABLED_STATUS);
    }
    const run = deps.runs.find(c.req.param("id"));
    if (!run) return c.json({ error: "not_found" }, 404);
    if (!GITHUB_ISSUE_RUN_TERMINAL.includes(run.status)) {
      return c.json({ error: "run_in_progress", status: run.status }, 409);
    }
    // 台帳から消してポーリングに拾わせる。 起動条件 (opt-in / 実行者 / ラベルが今も
    // 付いているか) を retry でも同じ経路で通すため、 ここで直接 invoke しない。
    deps.runs.remove(run.id);
    const result = await deps.pollOnce();
    const requeued = deps.runs.findByIssue(run.repo_origin, run.issue_number, run.label);
    return c.json({ ok: true, requeued: requeued ?? null, poll: result });
  });

  return app;
}
