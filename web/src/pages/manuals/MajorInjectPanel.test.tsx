// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { Manuals } from "../Manuals.js";
import { MajorInjectPanel } from "./MajorInjectPanel.js";

const sources = [
  { id: "session.work_policy", label: "Session policy", workflow: "session", case: "session.startup",
    target_kind: "builder", origin: "builtin_override", apply_scope: "next_startup_policy",
    placeholders: [], required_placeholders: [], max_bytes: 32768, restorable: true },
  { id: "session.process_guidance", label: "Process guidance", workflow: "session", case: "session.startup",
    target_kind: "builder", origin: "builtin_override", apply_scope: "next_startup_policy",
    placeholders: [], required_placeholders: [], max_bytes: 32768, restorable: true },
] as const;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function setupFetch(update?: (body: { content: string; expected_revision: string }) => Response) {
  const fetcher = vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
    const path = String(request);
    if (path === "/v1/harness-rules?all=1") return json({ rules: [] });
    if (path === "/v1/admin/inject-sources") return json({
      workflows: [{ id: "session", label: "セッション", cases: [{ id: "session.startup", label: "起動" }] }],
      sources,
    });
    const id = decodeURIComponent(path.split("/").pop() ?? "");
    const summary = sources.find((source) => source.id === id);
    if (!summary) return json({ error: "unknown_target" }, 404);
    if (options?.method === "PUT") return update?.(JSON.parse(String(options.body))) ?? json({ source: {
      ...summary, content: JSON.parse(String(options.body)).content, revision: "new-revision",
    } });
    return json({ source: { ...summary, content: id === sources[0].id ? "first" : "second", revision: id } });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps each unfinished draft across target and tab changes", async () => {
  setupFetch();
  render(<Manuals />);
  fireEvent.click(screen.getByRole("button", { name: "主要 Inject" }));
  const editor = await screen.findByRole("textbox", { name: "本文" });
  fireEvent.change(editor, { target: { value: "unsaved first" } });
  fireEvent.change(screen.getByLabelText("編集対象"), { target: { value: sources[1].id } });
  expect((await screen.findByRole("textbox", { name: "本文" }) as HTMLTextAreaElement).value).toBe("second");
  fireEvent.click(screen.getByRole("button", { name: "ハーネスルール" }));
  fireEvent.click(screen.getByRole("button", { name: "主要 Inject" }));
  fireEvent.change(screen.getByLabelText("編集対象"), { target: { value: sources[0].id } });
  expect((screen.getByRole("textbox", { name: "本文" }) as HTMLTextAreaElement).value).toBe("unsaved first");
});

it("preserves a draft on revision conflict and requires an explicit reload", async () => {
  const fetcher = setupFetch(() => json({ error: "revision_conflict", source: {
    ...sources[0], content: "someone else's revision", revision: "later",
  } }, 409));
  render(<MajorInjectPanel />);
  const editor = await screen.findByRole("textbox", { name: "本文" });
  fireEvent.change(editor, { target: { value: "my edit" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByText(/別の更新と競合しました/)).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "本文" }) as HTMLTextAreaElement).value).toBe("my edit");
  expect((screen.getByRole("textbox", { name: "保存済みの最新版" }) as HTMLTextAreaElement).value).toBe("someone else's revision");
  expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "最新版を読み込む" }));
  expect((screen.getByRole("textbox", { name: "本文" }) as HTMLTextAreaElement).value).toBe("someone else's revision");
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
    `/v1/admin/inject-sources/${encodeURIComponent(sources[0].id)}`,
    expect.objectContaining({ method: "PUT" }),
  ));
});
