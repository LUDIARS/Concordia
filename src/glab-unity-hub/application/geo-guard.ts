/**
 * 海外監視の運用面 (契約 v1 §2 海外監視)。
 *
 * 1. 接続時: Cloudflare を通っていない (かつ loopback でない) 接続はその場で拒否する。
 * 2. 認証後: 許可国外なら監査に記録し、 neco へ Discord で知らせる
 *    (同一トークン・同一国は 1 時間に 1 回まで)。 方針が block なら 4403 で切る。
 *
 * 通知の失敗で接続の可否は変えない (監査には残る)。
 *
 * @implements spec/feature/glab-unity-hub.md §2 (GUH-GEO)
 */

import { evaluateGeo, type GeoPolicy, type GeoVerdict } from "../domain/geo-policy.js";
import { HUB_LIMITS, KeyedThrottle, overseasNoticeKey } from "../domain/rate-limit.js";
import type { AuditLog, Clock, OverseasNotifier } from "./ports.js";
import type { HubIdentity } from "./authenticate.js";

export interface ConnectionOrigin {
  readonly cfCountry: string | null;
  readonly cfConnectingIp: string | null;
  readonly remoteAddress: string | null;
}

export interface GeoGuardDeps {
  readonly allowedCountries: readonly string[];
  readonly policy: GeoPolicy;
  readonly audit: AuditLog;
  readonly notifier: OverseasNotifier;
  readonly clock: Clock;
  readonly log?: (message: string) => void;
}

export class GeoGuard {
  private readonly notices = new KeyedThrottle(HUB_LIMITS.overseasNoticeWindowMs);

  constructor(private readonly deps: GeoGuardDeps) {}

  /** 接続時の判定。 拒否 (CF 非経由) なら監査に残して false 側の verdict を返す。 */
  admit(origin: ConnectionOrigin, channel: "ws" | "http"): GeoVerdict {
    const verdict = evaluateGeo({ ...origin, allowedCountries: this.deps.allowedCountries, policy: this.deps.policy });
    if (verdict.reason === "not_via_cloudflare") {
      this.deps.audit.record({
        kind: "geo", tokenId: null, discordUserId: null, country: null, ip: verdict.maskedIp,
        operation: `${channel}.connect`, result: "rejected_not_via_cloudflare",
      });
    }
    return verdict;
  }

  /** 認証が済んだ接続の海外判定。 通してよければ true。 */
  async afterAuth(verdict: GeoVerdict, identity: HubIdentity, channel: "ws" | "http"): Promise<boolean> {
    // 海外は block 方針でも、 誰の接続かを記録・通知してから切る。
    if (verdict.reason === "not_via_cloudflare") return false;
    if (!verdict.overseas) return true;
    return this.overseas(verdict, identity, channel);
  }

  /** block 方針で認証前に拒否する場合も、 記録だけは残す。 */
  recordBlockedBeforeAuth(verdict: GeoVerdict, channel: "ws" | "http"): void {
    this.deps.audit.record({
      kind: "geo", tokenId: null, discordUserId: null, country: verdict.country, ip: verdict.maskedIp,
      operation: `${channel}.connect`, result: verdict.reason,
    });
  }

  private async overseas(verdict: GeoVerdict, identity: HubIdentity, channel: "ws" | "http"): Promise<boolean> {
    const blocked = this.deps.policy === "block";
    this.deps.audit.record({
      kind: "geo", tokenId: identity.token.id, discordUserId: identity.token.discordUserId,
      country: verdict.country, ip: verdict.maskedIp, operation: `${channel}.connect`,
      result: blocked ? "overseas_blocked" : "overseas_monitored",
    });
    const key = overseasNoticeKey(identity.token.id, verdict.country);
    if (this.notices.tryPass(key, this.deps.clock.now().getTime())) {
      await this.deps.notifier.notify({
        tokenLabel: identity.token.label,
        discordUserId: identity.token.discordUserId,
        country: verdict.country,
        maskedIp: verdict.maskedIp,
        policy: this.deps.policy,
        blocked,
      }).catch((error: unknown) => {
        this.deps.log?.(`overseas notice failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return !blocked;
  }
}
