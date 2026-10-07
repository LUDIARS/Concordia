/**
 * AI セッションが主要 Inject 文面を調整するための管理 API クライアント。
 * WebUI と同じ順序 (履歴 GET で baseline → 本文 GET → 版付き PUT) で書き込み、
 * 変更履歴は Cc の DB 版履歴にそのまま残す。
 */

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ status: number; json(): Promise<unknown> }>;

export interface InjectSourceView {
  id: string;
  label?: string;
  apply_scope?: string;
  content: string;
  revision: string;
  history_version_id?: number | null;
}

export interface InjectHistoryEntry {
  version_id: number;
  parent_version_id: number | null;
  revision: string;
  actor: string;
  change_kind: string;
  created_at: number;
}

export class InjectSourceError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** 接続先は env からだけ決める。ポートを既定値で埋めない。 */
export function resolveConcordiaUrl(env: Record<string, string | undefined>): string {
  const explicit = env.CONCORDIA_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = env.CONCORDIA_PORT?.trim();
  if (port) return `http://${env.CONCORDIA_HOST?.trim() || "127.0.0.1"}:${port}`;
  throw new InjectSourceError("CONCORDIA_URL も CONCORDIA_PORT もありません。Cc の接続先を env で渡してください。", 0);
}

export class InjectSourceClient {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: FetchLike) {}

  async get(id: string): Promise<InjectSourceView> {
    const body = await this.request("GET", `/${encodeURIComponent(id)}`);
    return (body as { source: InjectSourceView }).source;
  }

  async history(id: string, limit = 20): Promise<InjectHistoryEntry[]> {
    const body = await this.request("GET", `/${encodeURIComponent(id)}/history?limit=${limit}`);
    return (body as { versions: InjectHistoryEntry[] }).versions;
  }

  /**
   * 読んだ revision と現在値が一致するときだけ書く。履歴 GET で baseline を作ってから
   * 本文を読み、その revision と版 ID を CAS 条件にする。競合は再送しない。
   */
  async apply(id: string, content: string, expectedRevision: string): Promise<InjectSourceView> {
    await this.history(id, 1);
    const current = await this.get(id);
    if (current.revision !== expectedRevision) {
      throw new InjectSourceError(
        `読んだ revision (${expectedRevision}) と現在の revision (${current.revision}) が違います。get で読み直してください。`,
        409, "stale_revision");
    }
    const body = await this.request("PUT", `/${encodeURIComponent(id)}`, {
      content,
      expected_revision: current.revision,
      expected_version_id: current.history_version_id ?? null,
    });
    return (body as { source: InjectSourceView }).source;
  }

  private async request(method: string, path: string, payload?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/admin/inject-sources${path}`, {
      method,
      headers: payload === undefined ? {} : { "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body = await res.json().catch(() => ({})) as { error?: string; source?: { revision?: string } };
    if (res.status >= 200 && res.status < 300) return body;
    const current = res.status === 409 && body.source?.revision ? ` 現在の revision: ${body.source.revision}` : "";
    throw new InjectSourceError(`${method} ${path} が ${res.status} (${body.error ?? "unknown"})。${current}`,
      res.status, body.error);
  }
}
