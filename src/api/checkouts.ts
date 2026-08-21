/**
 * /v1/checkouts — 登録 checkout を前進させてよいかの照会 (読み取り専用)。
 *
 *   GET /v1/checkouts/lock?repo_origin=<canonicalOrigin>&repo_path=<path>&branch=<ref>
 *     → 200 { allowed: true }
 *     → 200 { allowed: false, reason: "session_active", holders: [...] }
 *
 * Revisor はマージ済み main を登録 checkout へ fast-forward で降ろす前にここを叩く
 * (Revisor `spec/feature/checkout-publication.md` §3)。 契約は Cc
 * `spec/feature/checkout-lock-api.md`。
 *
 * 不変条件:
 *   - **claim を取らない**。 取ると Revisor の中止経路で解放漏れが起きる。
 *   - 判断材料が無いまま allowed:true を返さない。 入力不正は 4xx、 内部失敗は 5xx を返し、
 *     どちらも body に allowed:false を含めて呼び出し側の無言フォールバックを防ぐ。
 *   - 資格情報付き origin は受け取らない。 拒否時も原文をログ・レスポンスへ出さない。
 */

import { Hono } from "hono";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { checkRepoOrigin } from "../checkouts/origin-identity.js";
import { evaluateCheckoutLock } from "../checkouts/lock-evaluator.js";

export interface CheckoutsApiDeps {
  sessions: SessionsRepo;
  /**
   * testing claim の読み口。 未注入なら判断材料が欠けているので 503 で fail closed する
   * (endpoint 自体を生やさないと 404 になり、 呼び出し側が「まだ実装が無い」 と読んで
   * 降ろしてしまう余地が残るため、 生やしたうえで拒否する)。
   */
  claims: TestingClaimsRepo | undefined;
  /** 作業ルート群 (AdminState 由来)。 umbrella セッションを掴み手から除くのに使う。 */
  resolveWorkspaceRoots: () => string[];
  log?: { info: (m: string) => void; warn: (m: string) => void; error?: (m: string) => void };
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

export function checkoutsRouter(deps: CheckoutsApiDeps): Hono {
  const app = new Hono();

  app.get("/lock", (c) => {
    const repoPath = (c.req.query("repo_path") ?? "").trim();
    const branch = (c.req.query("branch") ?? "").trim();
    if (!repoPath || !branch) {
      return c.json(
        { allowed: false, error: "invalid_query", detail: "repo_path と branch は必須です。" },
        400,
      );
    }
    const origin = checkRepoOrigin(c.req.query("repo_origin"));
    if (!origin.ok) {
      // 原文は出さない (資格情報が混じっている可能性がある)。 理由の識別子だけ返す。
      deps.log?.warn(`checkout lock query rejected: repo_origin ${origin.reason}`);
      return c.json({ allowed: false, error: "invalid_repo_origin", reason: origin.reason }, 400);
    }

    if (!deps.claims) {
      deps.log?.warn("checkout lock unavailable: testing claims repo is not wired");
      return c.json({ allowed: false, error: "claims_unavailable" }, 503);
    }

    try {
      const now = nowSec();
      const result = evaluateCheckoutLock({
        query: { repo_origin: origin.origin, repo_path: repoPath, branch },
        sessions: deps.sessions.findAllActive(),
        claims: deps.claims.listActive(now),
        workspaceRoots: deps.resolveWorkspaceRoots(),
      });
      if (!result.allowed) {
        deps.log?.info(
          `checkout lock denied origin=${origin.origin} branch=${branch} ` +
            `reason=${result.reason} holders=${result.holders.length}`,
        );
      }
      return c.json(result);
    } catch (error) {
      // 判断材料を取れなかったときに allowed:true を返さない。 Revisor は 5xx を
      // allowed:false として扱う (無言フォールバック禁止)。
      deps.log?.error?.(`checkout lock evaluation failed: ${(error as Error).message}`);
      return c.json({ allowed: false, error: "internal_error" }, 500);
    }
  });

  return app;
}
