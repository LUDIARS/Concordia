import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { RemoteTaskStatus } from "./batch-policy.js";

const exec = promisify(execFile);
export type ObserveCommand = (executable: string, args: string[], cwd: string) => Promise<string>;
const observeCommand: ObserveCommand = async (executable, args, cwd) => (await exec(executable, args, {
  cwd, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 262_144, encoding: "utf8",
  env: { ...process.env, CODEX_CLOUD_TASKS_BASE_URL: "https://chatgpt.com/backend-api" },
})).stdout;

// Official `codex cloud list --json`: { tasks: TaskSummary[], cursor }. Only id/status are kept;
// titles and summaries are provider text and never leave this adapter.
const ListPage = z.object({
  tasks: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()).max(200),
  cursor: z.string().nullable().optional(),
});
const KNOWN: ReadonlySet<string> = new Set(["pending", "ready", "applied", "error"]);
const PAGE_SIZE = 20, MAX_PAGES = 5;

/** Read-only observation. Unlisted or unrecognised tasks are absent, never inferred finished. */
export async function observeCodexCloudTasks(input: {
  executable: string; cwd: string; environmentId: string; wanted: ReadonlySet<string>;
}, run: ObserveCommand = observeCommand): Promise<Map<string, RemoteTaskStatus>> {
  const observed = new Map<string, RemoteTaskStatus>();
  if (input.wanted.size === 0) return observed;
  let cursor: string | null | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = ["cloud", "list", "--env", input.environmentId, "--json", "--limit", String(PAGE_SIZE)];
    if (cursor) args.push("--cursor", cursor);
    let parsed: z.infer<typeof ListPage>;
    try { parsed = ListPage.parse(JSON.parse(await run(input.executable, args, input.cwd))); }
    catch { throw new Error("codex_cloud_observation_failed"); }
    for (const task of parsed.tasks) {
      if (input.wanted.has(task.id) && KNOWN.has(task.status)) observed.set(task.id, task.status as RemoteTaskStatus);
    }
    cursor = parsed.cursor;
    if (!cursor || [...input.wanted].every(id => observed.has(id))) break;
  }
  return observed;
}
