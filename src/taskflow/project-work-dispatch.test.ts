import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dispatchWorkPost, dispatchWorkMerge } from "./project-work-dispatch.js";

let dir: string;
const actor = async () => ({ role: "staff" as const, discordRoles: ["9"] });
const post = { guild: "1", channel: "2", id: "42", text: "new task" };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cc-work-"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify([{ repository: "example/game", base: "main", bindings: [
    { action: "task", guild: "1", channel: "2", prefix: "", discordRoles: ["9"], minimumRole: "staff", dataSource: "00000000-0000-4000-8000-000000000001", initial: "open", done: "done" },
  ] }]));
  vi.stubEnv("CC_PROJECT_WORK_ACTIONS", path);
  vi.stubEnv("CC_NOTION_TOKEN_EXAMPLE_GAME", "test");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
it("creates once, edits without resetting status, and finishes the referenced page", async () => {
  const absent = { results: [], has_more: false };
  const present = { results: [{ id: "page" }], has_more: false };
  const responses = [absent, {}, present, {}, present, {}];
  const request = vi.fn(async (_url: string, _init: RequestInit) => Response.json(responses.shift()));
  vi.stubGlobal("fetch", request);
  await Promise.all([dispatchWorkPost(post, actor), dispatchWorkPost({ ...post, text: "edited" }, actor)]);
  await dispatchWorkMerge("example/game", "main", "cc-task-42");
  const writes = request.mock.calls.filter(([url]) => url.includes("/pages"));
  expect(writes.map(([, init]) => init.method)).toEqual(["POST", "PATCH", "PATCH"]);
  expect(JSON.parse(String(writes[1]![1].body)).properties.Status).toBeUndefined();
  expect(JSON.parse(String(writes[2]![1].body)).properties.Status.status.name).toBe("done");
});
it("holds an uncertain creation until the same source becomes visible", async () => {
  const request = vi.fn(async (url: string) => {
    if (url.endsWith("/pages")) throw new Error("response lost");
    return Response.json({ results: [], has_more: false });
  });
  vi.stubGlobal("fetch", request);
  await expect(dispatchWorkPost(post, actor)).rejects.toThrow("response lost");
  await expect(dispatchWorkPost(post, actor)).rejects.toMatchObject({ code: "EEXIST" });
  expect(request.mock.calls.filter(([url]) => url.endsWith("/pages"))).toHaveLength(1);
});

it("requires both a registered employee and a permitted live Discord role before any Notion request", async () => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  await dispatchWorkPost(post, async () => ({ role: null, discordRoles: ["9"] }));
  await dispatchWorkPost(post, async () => ({ role: "executive", discordRoles: [] }));
  expect(request).not.toHaveBeenCalled();
});
