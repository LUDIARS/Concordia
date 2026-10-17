/**
 * @implements spec/feature/task-workflow-v3.md CC-AT-PAGE-01 CC-AT-PAGE-02
 *
 * Reads Actio `GET /api/tasks` page by page. Older Actio returns `{ tasks }` (one page,
 * no `nextCursor`); newer Actio returns `{ tasks, nextCursor }` with summaries only.
 * A missing, null or empty `nextCursor` marks the last page.
 */
import { z } from "zod";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:a9ed27ad */
import augurContract_66d68320 from './actio-task-page-path.contract.js'; /* augur-inject:contract-predicate:4ce4b349 */
import augurContract_3f65158e from './actio-task-next-cursor.contract.js'; /* augur-inject:contract-predicate:ce703db7 */

/** Actio's maximum page size; larger values are refused with 400. */
export const ACTIO_TASK_PAGE_LIMIT = 500;
const MAX_PAGES = 1_000;

export type ActioTaskPageFetch = (path: string) => Promise<unknown>;

/** The list path for one page: the caller's filters, the page size, and the cursor when continuing. */
export function actioTaskPagePath(query: URLSearchParams, cursor: string | null): string {
  const params = new URLSearchParams(query);
  params.set("limit", String(ACTIO_TASK_PAGE_LIMIT));
  if (cursor) params.set("cursor", cursor);
  else params.delete("cursor");
  return `/api/tasks?${params}`;
}
// @ts-expect-error augur-inject
actioTaskPagePath = contract(actioTaskPagePath, { ...augurContract_66d68320, contractId: 'actio-pages-C-1', mode: 'observe', sample: 1, where: 'src/taskflow/actio-task-pages.ts:17', rule: 'contract-wrap', id: '66d68320' }); /* augur-inject:contract-wrap:66d68320 */

/** The cursor of the next page, or null when this page is the last one. */
export function nextActioTaskCursor(page: { nextCursor?: string | null }): string | null {
  return typeof page.nextCursor === "string" && page.nextCursor.length > 0 ? page.nextCursor : null;
}
// @ts-expect-error augur-inject
nextActioTaskCursor = contract(nextActioTaskCursor, { ...augurContract_3f65158e, contractId: 'actio-pages-C-2', mode: 'observe', sample: 1, where: 'src/taskflow/actio-task-pages.ts:26', rule: 'contract-wrap', id: '3f65158e' }); /* augur-inject:contract-wrap:3f65158e */

/** Yields each page's tasks in order. Refuses a repeated cursor instead of looping forever. */
export async function* actioTaskPages<T>(
  fetchPage: ActioTaskPageFetch, query: URLSearchParams, item: z.ZodType<T, z.ZodTypeDef, unknown>,
): AsyncGenerator<T[]> {
  const schema = z.object({ tasks: z.array(item), nextCursor: z.string().nullable().optional() });
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let count = 0; count < MAX_PAGES; count += 1) {
    const page = schema.safeParse(await fetchPage(actioTaskPagePath(query, cursor)));
    if (!page.success) throw new Error("Invalid Actio task list response");
    yield page.data.tasks;
    cursor = nextActioTaskCursor(page.data);
    if (cursor === null) return;
    if (seen.has(cursor)) throw new Error("Actio task list cursor repeated");
    seen.add(cursor);
  }
  throw new Error("Actio task list exceeded the page limit");
}

/** Every task across all pages. */
export async function readAllActioTasks<T>(
  fetchPage: ActioTaskPageFetch, query: URLSearchParams, item: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T[]> {
  const tasks: T[] = [];
  for await (const page of actioTaskPages(fetchPage, query, item)) tasks.push(...page);
  return tasks;
}
