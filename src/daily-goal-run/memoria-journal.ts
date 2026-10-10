/**
 * Memoria の日記・ノートへ日のまとめを記載する port と HTTP adapter。
 *
 * @implements spec/feature/daily-goal-run.md — Memoria との契約 / 8. Memoria へ記載する / CC-DG-INV-10
 *
 * 結果は 3 通り: 書けた (ok) / 届いて拒否された (rejected = 未記載で残し後で再送) /
 * 結果不明 (unknown = 照合してから再送)。 接続先は composition root が `memoriaBaseUrl()` から渡す。
 */

export const DAILY_GOAL_JOURNAL_SOURCE = "concordia-daily-goal";

export function dailyGoalNoteExternalId(date: string): string { return `${DAILY_GOAL_JOURNAL_SOURCE}:${date}`; }

export type JournalCallResult<T> = { ok: true; value: T } | { ok: false; kind: "rejected" | "unknown"; error: string };

export interface MemoriaJournalPort {
  /** 日記のその日の外部節を置き換える (日記の他の欄は変えない)。 */
  putDiarySection(date: string, source: string, body: { title: string; markdown: string }): Promise<JournalCallResult<{ url?: string }>>;
  /** 記載済みかの照合。 */
  getDiarySection(date: string, source: string): Promise<JournalCallResult<{ exists: boolean; url?: string }>>;
  /** ノートを 1 本作る。 同じ external_id なら既存を返す。 */
  createNote(input: { external_id: string; title: string; markdown: string; source: string }): Promise<JournalCallResult<{ id: string; url?: string }>>;
}

type FetchLike = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function urlOf(body: unknown): string | undefined {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>).url : undefined;
  return typeof value === "string" && value ? value : undefined;
}

export function createMemoriaJournalHttp(opts: { baseUrl: string; fetch?: FetchLike; timeoutMs?: number }): MemoriaJournalPort {
  const fetcher = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown } | { error: string }> => {
    try {
      const response = await fetcher(`${base}${path}`, {
        method,
        ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    } catch (error) {
      return { error: String(error) };
    }
  };
  /** 4xx は届いて拒否された (未記載)。 5xx と通信失敗は書けたかが分からない (結果不明)。 */
  const failure = (result: { status: number } | { error: string }): { ok: false; kind: "rejected" | "unknown"; error: string } =>
    "error" in result ? { ok: false, kind: "unknown", error: result.error }
      : { ok: false, kind: result.status >= 500 ? "unknown" : "rejected", error: `memoria responded ${result.status}` };
  const diaryPath = (date: string, source: string) => `/api/diary/${encodeURIComponent(date)}/sections/${encodeURIComponent(source)}`;
  return {
    async putDiarySection(date, source, body) {
      const result = await call("PUT", diaryPath(date, source), body);
      if ("error" in result || result.status < 200 || result.status >= 300) return failure(result);
      return { ok: true, value: { ...(urlOf(result.body) ? { url: urlOf(result.body)! } : {}) } };
    },
    async getDiarySection(date, source) {
      const result = await call("GET", diaryPath(date, source));
      if (!("error" in result) && result.status === 404) return { ok: true, value: { exists: false } };
      if ("error" in result || result.status < 200 || result.status >= 300) return failure(result);
      return { ok: true, value: { exists: true, ...(urlOf(result.body) ? { url: urlOf(result.body)! } : {}) } };
    },
    async createNote(input) {
      const result = await call("POST", "/api/notes/from-text", input);
      if ("error" in result || result.status < 200 || result.status >= 300) return failure(result);
      const body = (result.body ?? {}) as Record<string, unknown>;
      const note = (body.note && typeof body.note === "object" ? body.note : body) as Record<string, unknown>;
      const id = typeof note.id === "string" || typeof note.id === "number" ? String(note.id) : "";
      if (!id) return { ok: false, kind: "unknown", error: "memoria returned no note id" };
      const url = urlOf(note) ?? urlOf(body);
      return { ok: true, value: { id, ...(url ? { url } : {}) } };
    },
  };
}
