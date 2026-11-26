/**
 * Notion のタスクボード (NotionBoardPort の HTTP 実装、 Notion API 2025-09-03)。
 *
 * ボードは設定の許可リストだけ。 鍵は既存の Concordia の Notion 連携と同じ置き場
 * (env `CC_NOTION_TOKEN_<credentialKey>`) から引く。 更新は対象ページがそのボードの
 * data source の行であることを確かめてから行う (他のボードの行を書き換えない)。
 *
 * @implements spec/feature/glab-unity-hub.md §2 (GUH-NOTION)
 */

import { HubError } from "../domain/protocol.js";
import {
  boardProperties,
  findBoard,
  notionCredentialEnvName,
  pageBelongsToBoard,
  toBoardItem,
  type BoardItem,
  type NotionBoardConfig,
} from "../domain/notion-board.js";
import type { NotionBoardPort } from "../application/ports.js";

const NOTION_API = "https://api.notion.com/v1/";
const NOTION_VERSION = "2025-09-03";
const PAGE_SIZE = 50;

export class NotionBoardClient implements NotionBoardPort {
  constructor(
    private readonly boards: readonly NotionBoardConfig[],
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async query(boardId: string, cursor: string | undefined): Promise<{ items: BoardItem[]; nextCursor: string | null }> {
    const board = this.board(boardId);
    const body = await this.call(board, "POST", `data_sources/${encodeURIComponent(board.dataSourceId)}/query`, {
      page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}),
    }) as { results?: unknown[]; next_cursor?: unknown };
    const items = (body.results ?? []).flatMap((page) => {
      const item = toBoardItem(page, board);
      return item ? [item] : [];
    });
    return { items, nextCursor: typeof body.next_cursor === "string" ? body.next_cursor : null };
  }

  async update(boardId: string, pageId: string, input: { title?: string; status?: string; due?: string | null }): Promise<{ pageId: string }> {
    const board = this.board(boardId);
    const page = await this.call(board, "GET", `pages/${encodeURIComponent(pageId)}`);
    if (!pageBelongsToBoard(page, board)) throw new HubError("not_found", "page is not on this board");
    let properties: Record<string, unknown>;
    try {
      properties = boardProperties(board, input);
    } catch {
      throw new HubError("invalid_request", "this board has no due property");
    }
    await this.call(board, "PATCH", `pages/${encodeURIComponent(pageId)}`, { properties });
    return { pageId };
  }

  async create(boardId: string, input: { title: string; status?: string }): Promise<{ pageId: string }> {
    const board = this.board(boardId);
    const created = await this.call(board, "POST", "pages", {
      parent: { type: "data_source_id", data_source_id: board.dataSourceId },
      properties: boardProperties(board, input),
    }) as { id?: unknown };
    if (typeof created.id !== "string") throw new HubError("upstream_unavailable", "Notion did not return a page id");
    return { pageId: created.id };
  }

  private board(boardId: string): NotionBoardConfig {
    const board = findBoard(this.boards, boardId);
    if (!board) throw new HubError("not_found", "board is not in glabUnityHub.notionBoards");
    return board;
  }

  private async call(board: NotionBoardConfig, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> {
    const token = this.env[notionCredentialEnvName(board.credentialKey)]?.trim();
    if (!token) throw new HubError("upstream_unavailable", "Notion credential for this board is not configured");
    let response: Response;
    try {
      response = await this.fetchImpl(NOTION_API + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Notion-Version": NOTION_VERSION },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new HubError("upstream_unavailable", "Notion is unreachable");
    }
    if (response.status === 404) throw new HubError("not_found", "Notion object not found");
    if (response.status === 400) throw new HubError("invalid_request", "Notion rejected the update (check status / property names)");
    if (response.status === 429) throw new HubError("rate_limited", "Notion rate limit");
    if (!response.ok) throw new HubError("upstream_unavailable", `Notion returned HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  }
}
