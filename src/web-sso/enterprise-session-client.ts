/**
 * Cernere の企業セッション (module "enterprise") を呼ぶ最小のクライアント。
 * login は Cloudflare Access の JWT を Cernere に渡して検証させる (CC-SSO-INV-02)。Cc 自身は JWT を解かない。
 */

import { CernereRejectedError } from "./cernere-project-channel.js";

export interface EnterpriseSessionInfo {
  userId: string;
  projectKey: string;
  organizationId: string;
  organizationRole: string;
  /** 秒 (UNIX 時刻) */
  expiresAt: number;
}

export interface EnterpriseChannel {
  request(module: string, action: string, payload: Record<string, unknown>): Promise<unknown>;
}

export class EnterpriseSessionClient {
  constructor(private readonly channel: EnterpriseChannel) {}

  async login(assertion: string): Promise<{ enterpriseToken: string; session: EnterpriseSessionInfo }> {
    const result = await this.channel.request("enterprise", "login", { assertion }) as Record<string, unknown> | null;
    const token = result?.enterpriseToken;
    if (typeof token !== "string" || !token) throw new CernereRejectedError("Cernere returned no enterprise token");
    return { enterpriseToken: token, session: parseSession(result?.session) };
  }

  async verify(enterpriseToken: string): Promise<EnterpriseSessionInfo> {
    return parseSession(await this.channel.request("enterprise", "verify", { enterpriseToken }));
  }

  async logout(enterpriseToken: string): Promise<void> {
    await this.channel.request("enterprise", "logout", { enterpriseToken });
  }
}

function parseSession(value: unknown): EnterpriseSessionInfo {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const text = (key: string): string => (typeof v[key] === "string" ? v[key] as string : "");
  const session = {
    userId: text("userId"),
    projectKey: text("projectKey"),
    organizationId: text("organizationId"),
    organizationRole: text("organizationRole"),
    expiresAt: typeof v.expiresAt === "number" ? v.expiresAt : 0,
  };
  if (!session.userId || !session.projectKey || !session.expiresAt) {
    throw new CernereRejectedError("Cernere returned an incomplete enterprise session");
  }
  return session;
}
