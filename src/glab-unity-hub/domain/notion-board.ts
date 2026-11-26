/**
 * Notion のタスクボードと Hub の項目の対応 (契約 v1 §2 `notion.board.*`)。
 *
 * ボードは設定の許可リスト (`glabUnityHub.notionBoards`) にあるものだけ扱う。 1 件は
 * id・name・data source id・プロパティ名の対応・鍵の置き場 (credentialKey) を持つ。
 * 鍵は既存の Concordia の Notion 連携と同じく env `CC_NOTION_TOKEN_<credentialKey>` から引く。
 *
 * @implements spec/feature/glab-unity-hub.md §2 (GUH-NOTION)
 */

export interface NotionBoardConfig {
  readonly id: string;
  readonly name: string;
  readonly dataSourceId: string;
  readonly credentialKey: string;
  readonly properties: {
    readonly title: string;
    readonly status: string;
    /** Notion のプロパティ種別。 `status` 型か `select` 型か。 */
    readonly statusType: "status" | "select";
    readonly assignees: string | null;
    readonly due: string | null;
  };
}

export interface BoardItem {
  readonly pageId: string;
  readonly title: string;
  readonly status: string | null;
  readonly assignees: readonly string[];
  readonly due: string | null;
  readonly url: string | null;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
}

export function findBoard(boards: readonly NotionBoardConfig[], boardId: string): NotionBoardConfig | null {
  return boards.find((board) => board.id === boardId) ?? null;
}

/** env 名に使う鍵キー (英大文字・数字・_)。 */
export function notionCredentialEnvName(credentialKey: string): string {
  return "CC_NOTION_TOKEN_" + credentialKey.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function plainText(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return items.map((item) => {
    const text = record(item)?.plain_text;
    return typeof text === "string" ? text : "";
  }).join("");
}

/** Notion の page オブジェクト 1 件を Hub の項目へ写す。 */
export function toBoardItem(page: unknown, board: NotionBoardConfig): BoardItem | null {
  const root = record(page);
  const pageId = root?.id;
  if (typeof pageId !== "string") return null;
  const props = record(root?.properties) ?? {};
  const title = plainText(record(props[board.properties.title])?.title);
  const statusProp = record(props[board.properties.status]);
  const statusValue = record(statusProp?.[board.properties.statusType]);
  const status = typeof statusValue?.name === "string" ? statusValue.name : null;
  const people = board.properties.assignees ? record(props[board.properties.assignees])?.people : null;
  const assignees = Array.isArray(people)
    ? people.flatMap((person) => {
      const name = record(person)?.name;
      return typeof name === "string" && name !== "" ? [name] : [];
    })
    : [];
  const dateProp = board.properties.due ? record(record(props[board.properties.due])?.date) : null;
  const due = typeof dateProp?.start === "string" ? dateProp.start : null;
  const url = typeof root?.url === "string" ? root.url : null;
  return { pageId, title, status, assignees, due, url };
}

/** 更新・作成で Notion へ送る properties を組む。 指定が無い項目は触らない。 */
export function boardProperties(board: NotionBoardConfig, input: {
  readonly title?: string;
  readonly status?: string;
  readonly due?: string | null;
}): Json {
  const properties: Json = {};
  if (input.title !== undefined) {
    properties[board.properties.title] = { title: [{ type: "text", text: { content: input.title } }] };
  }
  if (input.status !== undefined) {
    properties[board.properties.status] = { [board.properties.statusType]: { name: input.status } };
  }
  if (input.due !== undefined) {
    if (!board.properties.due) throw new Error("board has no due property");
    properties[board.properties.due] = { date: input.due === null ? null : { start: input.due } };
  }
  return properties;
}

/** 対象ページが本当にこのボードの data source の行か (他のボードの行を書き換えない)。 */
export function pageBelongsToBoard(page: unknown, board: NotionBoardConfig): boolean {
  const parent = record(record(page)?.parent);
  const dataSourceId = parent?.data_source_id;
  if (typeof dataSourceId !== "string") return false;
  return normalizeNotionId(dataSourceId) === normalizeNotionId(board.dataSourceId);
}

export function normalizeNotionId(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}
