/**
 * src/domain-review/anatomia-client.ts — warm Anatomia server の読み取り。
 *
 * Anatomia がドメイン情報の所有者で、 Concordia は読むだけ。 落ちている・
 * 未登録・未 prepare のいずれでも **例外を投げず区別できる値**を返す — 呼び出し側は
 * 「投稿せず黙って諦める」 のか 「生データで代替する」 のかをここの戻り値で決める。
 *
 * `cache-stats-client.ts` と同じく node:http + agent:false + 短い timeout。
 * Windows の libuv assert 対策と、 Anatomia が重いときに Cc を巻き込まないため。
 *
 * SRP: HTTP 取得と形の絞り込みだけ。 レポートの組み立ては report.ts。
 *
 * @implements spec/feature/domain-review-discord.md §2.4
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { anatomiaBaseUrl } from "../config/service-urls.js";

/** prepared view の異常膨張で Concordia process のメモリを使い切らないための上限。 */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** 未 prepare は 409。 404 は未登録。 それ以外の失敗は unreachable に畳む。 */
export type AnatomiaFetch<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "not-prepared" | "not-found" | "unreachable" };

/** `GET /api/projects` の 1 件。 使うのは id と rootPath だけ。 */
export interface AnatomiaProjectSummary {
  id: string;
  rootPath: string;
}

/** `GET /api/projects/:id/domains` の 1 件 (未 prepare 時のフォールバック源)。 */
export interface AnatomiaRawDomain {
  domain: string;
  implementorCount: number;
  conforms: boolean;
  violationCount: number;
}

export interface AnatomiaDomainClientOptions {
  /** 既定は共通 service URL resolver (`ANATOMIA_BASE_URL`)。 */
  baseUrl?: string;
  timeoutMs?: number;
}

export class AnatomiaDomainClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: AnatomiaDomainClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? anatomiaBaseUrl()).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 4_000;
  }

  /** 登録プロジェクト一覧。 Anatomia が落ちていれば unreachable。 */
  listProjects(): Promise<AnatomiaFetch<AnatomiaProjectSummary[]>> {
    return this.getJson<{ projects?: unknown }>("/api/projects").then((result) => {
      if (!result.ok) return result;
      const projects = Array.isArray(result.data.projects) ? result.data.projects : [];
      return {
        ok: true as const,
        data: projects.flatMap((entry): AnatomiaProjectSummary[] => {
          if (!isRecord(entry)) return [];
          const id = entry["id"];
          const rootPath = entry["rootPath"];
          if (typeof id !== "string" || typeof rootPath !== "string") return [];
          return [{ id, rootPath }];
        }),
      };
    });
  }

  /**
   * repoPath に対応する Anatomia project id。 worktree は本体 root と別パスなので、
   * 完全一致しなければ「この repo を含む登録」を **最長一致**で拾う
   * (`E:/Document/Ars/Concordia-feat-x` が `Concordia` に落ちることはない —
   * 区切り単位で比べるため)。 見つからなければ ok + null、一覧取得失敗は理由付きで返す。
   */
  async resolveProjectId(repoPath: string): Promise<AnatomiaFetch<string | null>> {
    const projects = await this.listProjects();
    if (!projects.ok) return projects;
    return { ok: true, data: matchProjectId(repoPath, projects.data) };
  }

  fetchBusinessDomainView(projectId: string): Promise<AnatomiaFetch<unknown>> {
    return this.getJson(`/api/projects/${encodeURIComponent(projectId)}/business-domain-view`);
  }

  fetchProgramDomainView(projectId: string): Promise<AnatomiaFetch<unknown>> {
    return this.getJson(`/api/projects/${encodeURIComponent(projectId)}/program-domain-view`);
  }

  /** 未 prepare 時のフォールバック。 ドメイン名と実装数・逸脱数だけが取れる。 */
  fetchRawDomains(projectId: string): Promise<AnatomiaFetch<AnatomiaRawDomain[]>> {
    return this.getJson<unknown>(`/api/projects/${encodeURIComponent(projectId)}/domains`)
      .then((result) => {
        if (!result.ok) return result;
        if (!Array.isArray(result.data)) return { ok: false as const, reason: "unreachable" as const };
        return {
          ok: true as const,
          data: result.data.flatMap((entry): AnatomiaRawDomain[] => {
            if (!isRecord(entry) || typeof entry["domain"] !== "string") return [];
            return [{
              domain: entry["domain"],
              implementorCount: numberOr(entry["implementorCount"], 0),
              conforms: entry["conforms"] !== false,
              violationCount: numberOr(entry["violationCount"], 0),
            }];
          }),
        };
      });
  }

  private getJson<T>(path: string): Promise<AnatomiaFetch<T>> {
    const url = `${this.baseUrl}${path}`;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: AnatomiaFetch<T>) => { if (!settled) { settled = true; resolve(value); } };
      try {
        const parsed = new URL(url);
        const request = parsed.protocol === "http:"
          ? httpRequest
          : parsed.protocol === "https:"
            ? httpsRequest
            : null;
        if (!request) return finish({ ok: false, reason: "unreachable" });
        const req = request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: "GET",
            agent: false,
          },
          (res) => {
            const status = res.statusCode ?? 0;
            let body = "";
            let bodyBytes = 0;
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              bodyBytes += Buffer.byteLength(chunk, "utf8");
              if (bodyBytes > MAX_RESPONSE_BYTES) {
                req.destroy();
                finish({ ok: false, reason: "unreachable" });
                return;
              }
              body += chunk;
            });
            res.on("end", () => {
              // 409 (not-prepared) と 404 (未登録) は「取れなかった」ではなく状態。
              // unreachable と一緒にすると、 prepare を促すべき場面で黙る羽目になる。
              if (status === 409) return finish({ ok: false, reason: "not-prepared" });
              if (status === 404) return finish({ ok: false, reason: "not-found" });
              if (status < 200 || status >= 300) return finish({ ok: false, reason: "unreachable" });
              try {
                finish({ ok: true, data: JSON.parse(body) as T });
              } catch {
                finish({ ok: false, reason: "unreachable" });
              }
            });
          },
        );
        req.setTimeout(this.timeoutMs, () => { req.destroy(); finish({ ok: false, reason: "unreachable" }); });
        req.on("error", () => finish({ ok: false, reason: "unreachable" }));
        req.end();
      } catch {
        finish({ ok: false, reason: "unreachable" });
      }
    });
  }
}

/**
 * repoPath → Anatomia project id。 完全一致が最優先で、 無ければ repoPath を
 * 含む登録のうち最も深いものを採る (worktree から本体登録へ寄せるため)。
 */
export function matchProjectId(
  repoPath: string,
  projects: readonly AnatomiaProjectSummary[],
): string | null {
  const target = normalizePath(repoPath);
  if (!target) return null;
  let best: { id: string; depth: number } | null = null;
  for (const project of projects) {
    const root = normalizePath(project.rootPath);
    if (!root) continue;
    if (root === target) return project.id;
    if (!target.startsWith(`${root}/`)) continue;
    const depth = root.split("/").length;
    if (!best || depth > best.depth) best = { id: project.id, depth };
  }
  return best?.id ?? null;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
