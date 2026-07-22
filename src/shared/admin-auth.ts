/**
 * admin / sweeper エンドポイントの信頼境界を担保する認証ミドルウェア。
 *
 * Concordia は元来 loopback (127.0.0.1) 前提で admin API を無認証公開してきた。
 * 非 loopback に bind するケース (LAN 公開 / 0.0.0.0) に備え、 token を設定すると
 * `/v1/admin/*` と `/v1/sweeper/run` に bearer 認証を課す。 信頼境界の判定は
 * `shared/config.ts:isLoopbackHost()`、 起動時の token 必須化は `server.ts` が担う。
 */

import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";

/** 定数時間比較で token 一致を判定する (タイミング攻撃対策)。 空同士は不一致扱い。 */
export function tokensMatch(expected: string, got: string): boolean {
  if (!expected || !got) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <token>` から token 部を取り出す (大文字小文字無視)。 */
export function extractBearer(authHeader: string | undefined): string {
  const v = (authHeader ?? "").trim();
  if (v.toLowerCase().startsWith("bearer ")) return v.slice("bearer ".length).trim();
  return "";
}

/**
 * admin ルート用の認証ミドルウェアを生成する。
 *
 * - `getAdminToken()` が空文字列: 503 で fail closed。loopback は認証主体の代わりに
 *   ならず、空 token を allow-all として扱わない。
 * - token が設定済み: `Authorization: Bearer <token>` または
 *   `X-Concordia-Admin-Token: <token>` の一致を要求し、 不一致なら 401。
 *
 * token は live 解決 (関数経由) なので、 設定変更が次リクエストから反映される。
 */
export function adminAuthMiddleware(getAdminToken: () => string): MiddlewareHandler {
  return async (c, next) => {
    const token = (getAdminToken() ?? "").trim();
    if (!token) {
      return c.json(
        { error: "authentication_not_configured", hint: "set CONCORDIA_ADMIN_TOKEN" },
        503,
      );
    }
    const got =
      extractBearer(c.req.header("authorization")) ||
      (c.req.header("x-concordia-admin-token") ?? "").trim();
    if (!tokensMatch(token, got)) {
      return c.json(
        { error: "unauthorized", hint: "admin token required (CONCORDIA_ADMIN_TOKEN)" },
        401,
      );
    }
    return next();
  };
}
