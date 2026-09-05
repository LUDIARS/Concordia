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
import { classifyIssueEvent } from "../github/issue-event.js";
import { verifyGithubSignature } from "../github/signature.js";
import { dispatchIssueTrigger, type GithubDispatchDeps } from "../github/dispatch.js";
import { workflowDisabledBody, WORKFLOW_DISABLED_STATUS } from "../workflow/api-gate.js";

const log = createChildLogger("github-webhook");
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

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
    // 一致しないので、 必ず生本文で検証してから parse する。
    const body = await c.req.text();
    let secret: string | null;
    try {
      secret = deps.config.webhookSecret();
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

    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

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
