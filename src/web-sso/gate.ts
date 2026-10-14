/**
 * 公開ホストの入口判定 (spec/feature/web-sso.md CC-SSO-INV-01〜04)。
 *
 *  - 公開側でない要求 (loopback / Tailscale) は今の境界のまま通す ("local")。
 *  - 公開側は Cookie の企業セッションを Cernere で verify する。無い・失効なら
 *    cf-access-jwt-assertion で Cernere に login させ、新しい token を Cookie に置く。
 *  - Cernere が今有効と答え、組織ロールが owner / admin の人だけ通す。
 *  - Cernere に届かなければ拒否する (ローカル判定へ fallback しない)。
 */

import { CernereRejectedError } from "./cernere-project-channel.js";
import type { EnterpriseSessionClient, EnterpriseSessionInfo } from "./enterprise-session-client.js";
import { clearSsoCookie, isPublicRequest, readSsoCookie, roleAllowed, ssoCookie, type HeaderReader } from "./policy.js";

export type GateDecision =
  | { kind: "local" }
  | { kind: "allow"; session: EnterpriseSessionInfo; setCookie?: string }
  | { kind: "deny"; status: 401 | 403 | 503; reason: string; setCookie?: string };

export interface GateOptions {
  publicHost: string;
  projectKey: string;
  client: Pick<EnterpriseSessionClient, "login" | "verify">;
  /** WS の upgrade では Cookie を発行できないので login しない。 */
  allowLogin?: boolean;
  now?: () => number;
}

export async function decideAccess(header: HeaderReader, options: GateOptions): Promise<GateDecision> {
  if (!isPublicRequest(options.publicHost, header)) return { kind: "local" };
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const cookieToken = readSsoCookie(header("cookie"));
  let staleCookie = false;

  if (cookieToken) {
    try {
      return admit(await options.client.verify(cookieToken), options.projectKey);
    } catch (error) {
      if (!(error instanceof CernereRejectedError)) return unavailable();
      staleCookie = true;
    }
  }

  const assertion = header("cf-access-jwt-assertion")?.trim() ?? "";
  const cleared = staleCookie ? clearSsoCookie() : undefined;
  if (options.allowLogin === false || !assertion) {
    return { kind: "deny", status: 401, reason: "Cloudflare でログインしてから開いてください", setCookie: cleared };
  }
  try {
    const { enterpriseToken, session } = await options.client.login(assertion);
    const decision = admit(session, options.projectKey);
    if (decision.kind === "deny") return { ...decision, setCookie: cleared };
    if (decision.kind === "local") return decision;
    return { ...decision, setCookie: ssoCookie(enterpriseToken, session.expiresAt - now()) };
  } catch (error) {
    if (!(error instanceof CernereRejectedError)) return unavailable();
    return { kind: "deny", status: 403, reason: "Cernere がこのログインを認めませんでした", setCookie: cleared };
  }
}

function admit(session: EnterpriseSessionInfo, projectKey: string): GateDecision {
  if (session.projectKey !== projectKey) return { kind: "deny", status: 403, reason: "別のアプリ向けの企業セッションです" };
  if (!roleAllowed(session.organizationRole)) {
    return { kind: "deny", status: 403, reason: "公開ホストは組織の owner / admin だけが使えます" };
  }
  return { kind: "allow", session };
}

function unavailable(): GateDecision {
  return { kind: "deny", status: 503, reason: "Cernere に確認できないため公開ホストからは開けません" };
}
