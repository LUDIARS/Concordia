/**
 * GitHub 連携の管理面 (loopback)。 webhook secret はここだけで書き、 値は返さない。
 *
 * @implements spec/feature/github-issue-workflow.md — 操作面
 */

import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { GithubActorRow } from "../db/github-actors-repo.js";
import type { GithubWorkflowConfig } from "../github/config.js";
import { isOwnerRepo, normalizeRepoOrigin } from "../pr/normalize.js";

const SecretSchema = z.object({
  /** 省略すると Cc が生成して返す (GitHub 側の webhook 設定へ貼る用)。 */
  secret: z.string().trim().min(16).max(200).optional(),
  /**
   * 対象リポジトリ (owner/name)。 指定するとそのリポ専用の secret を書く。
   * 省略時は共通 secret (リポ別が無いときのフォールバック) を書く。
   */
  repo: z.string().trim().min(3).max(200).optional(),
}).strict();

export interface GithubAdminRouterDeps {
  config: GithubWorkflowConfig;
  /** opt-in 済みプロジェクトの数 (設定画面の現況表示)。 */
  optedInProjects: () => Array<{ code: string; project: string; repo_origin: string | null }>;
  /**
   * 観測済み login の名簿 (未注入なら空)。 権限ではなく候補 — 「後追いで信頼実行者へ
   * 足す」操作で login を手入力させないために出す。
   * @implements spec/feature/github-issue-workflow.md — 信頼実行者
   */
  actors?: (limit: number) => GithubActorRow[];
}

/**
 * 観測名簿に「今その login が信頼実行者か」を重ねて返す。 判定は設定側が正本なので、
 * ここでは表示のために突き合わせるだけ。 大文字小文字は小文字へ畳んで比較する。
 */
function actorRoster(deps: GithubAdminRouterDeps): Array<GithubActorRow & { trusted: boolean }> {
  const trusted = new Set(deps.config.trustedActors().map((login) => login.trim().toLowerCase()));
  return (deps.actors?.(100) ?? []).map((row) => ({
    ...row,
    trusted: trusted.has(row.login.toLowerCase()),
  }));
}

/**
 * repo の名乗りを保存キーと同じ形 (owner/name) へ畳む。 畳めない表記を通すと
 * 「保存はできたのに webhook 側から一生引かれない secret」が出来てしまうので、
 * ここで弾いて操作者に返す。
 */
function ownerRepoOrNull(raw: string): string | null {
  const normalized = normalizeRepoOrigin(raw);
  return isOwnerRepo(normalized) ? normalized : null;
}

export function githubAdminRouter(deps: GithubAdminRouterDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    let secretSet = false;
    let secretError: string | null = null;
    try {
      secretSet = deps.config.webhookSecret() !== null;
    } catch {
      // secret box 未設定は「設定できない」状態。 未設定と区別して見せる。
      secretError = "webhook secret を復号できません。Concordia の secret-box 設定を確認してください";
    }
    return c.json({
      webhook_secret_set: secretSet,
      webhook_secret_error: secretError,
      label: deps.config.label(),
      trusted_actors: deps.config.trustedActors(),
      base_branch: deps.config.baseBranch(),
      fix_call_name: deps.config.fixCallName(),
      poll_interval_min: Math.round(deps.config.pollIntervalMs() / 60_000),
      projects: deps.optedInProjects().map((project) => ({
        ...project,
        // リポジトリ別 secret を持っているか。 値は返さない。
        webhook_secret_set: project.repo_origin !== null
          && deps.config.hasRepoWebhookSecret(project.repo_origin),
      })),
      actors: actorRoster(deps),
    });
  });

  app.put("/webhook-secret", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = SecretSchema.safeParse(body ?? {});
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    let repo: string | null = null;
    if (parsed.data.repo !== undefined) {
      repo = ownerRepoOrNull(parsed.data.repo);
      if (repo === null) return c.json({ error: "invalid_repo" }, 400);
    }
    const secret = parsed.data.secret ?? randomBytes(24).toString("base64url");
    try {
      if (repo) deps.config.setRepoWebhookSecret(repo, secret);
      else deps.config.setWebhookSecret(secret);
    } catch {
      return c.json({ error: "secret_store_unavailable" }, 503);
    }
    // 生成したときだけ値を返す。 GitHub 側へ貼る先がここしか無いため。
    return c.json({ ok: true, secret: parsed.data.secret ? null : secret });
  });

  app.delete("/webhook-secret", (c) => {
    // ?repo=owner/name でリポジトリ別だけを消す。 省略時は共通 secret。
    const raw = c.req.query("repo")?.trim();
    const repo = raw ? ownerRepoOrNull(raw) : null;
    if (raw && repo === null) return c.json({ error: "invalid_repo" }, 400);
    try {
      if (repo) deps.config.clearRepoWebhookSecret(repo);
      else deps.config.clearWebhookSecret();
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "secret_store_unavailable" }, 503);
    }
  });

  return app;
}
