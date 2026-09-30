/**
 * Tabula への投稿 (spec/feature/tech-consultation.md §5 SPEC-CONSULT-TABULA)。
 *
 * 取り込み API (`POST /api/imports`) にメンバー共有 (`visibility: shared`) のページとして送る。
 * ページ所有者は Tabula 側の取り込み用所有者のまま。 接続先とトークンは Cc の設定 (schema_meta、 secret-box で
 * 暗号化されている) から復号済みで渡される。
 * 失敗時の例外には応答本文を載せない (トークンや相談内容をログへ流さない)。
 *
 * @implements SPEC-CONSULT-TABULA
 */

export interface TabulaConnection {
  url: string;
  token: string;
}

export interface TabulaImportInput {
  /** 冪等キー (同じ公開候補を二重に作らない)。 */
  key: string;
  title: string;
  text: string;
  tags: readonly string[];
}

export interface TabulaImportResult {
  pageId: string;
  url: string;
}

export class TabulaImportError extends Error {
  constructor(readonly code: "unreachable" | "rejected" | "malformed_response", readonly status: number | null) {
    super(`tabula import failed: ${code}${status === null ? "" : ` (${status})`}`);
    this.name = "TabulaImportError";
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function importSharedPage(
  connection: TabulaConnection,
  input: TabulaImportInput,
  fetchImpl: FetchLike = fetch,
): Promise<TabulaImportResult> {
  const endpoint = `${connection.url.replace(/\/+$/, "")}/api/imports`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({
        key: input.key,
        visibility: "shared",
        bundle: {
          note: { title: input.title, tags: [...input.tags] },
          blocks: paragraphs(input.text).map((text) => ({ block_type: "text", text })),
        },
      }),
    });
  } catch {
    throw new TabulaImportError("unreachable", null);
  }
  if (!response.ok) throw new TabulaImportError("rejected", response.status);
  const body = await response.json().catch(() => null) as { note?: { id?: unknown }; url?: unknown } | null;
  const pageId = body?.note?.id;
  const url = body?.url;
  if (typeof pageId !== "string" || typeof url !== "string") throw new TabulaImportError("malformed_response", response.status);
  return { pageId, url };
}

/** 保存済みの設定から接続を組み立てる。 どちらかが無ければ null (公開ボタンを出さない)。 */
export function readTabulaConnection(input: { url: string | null; token: string | null }): TabulaConnection | null {
  const url = input.url?.trim();
  const token = input.token?.trim();
  return url && token ? { url, token } : null;
}

function paragraphs(text: string): string[] {
  const parts = text.split(/\r?\n\s*\r?\n/).map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [text.trim()];
}
