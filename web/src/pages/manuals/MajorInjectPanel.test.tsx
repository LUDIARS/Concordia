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
  { id: "rules.session_work", label: "Session rule", workflow: "rules", case: "file",
    target_kind: "file", origin: "repo_file", apply_scope: "next_file_read",
    placeholders: [], required_placeholders: [], max_bytes: 32768, restorable: false },
  { id: "session.context.ddd_report", label: "DDD report", workflow: "session", case: "session.startup",
    target_kind: "builder", origin: "builtin_override", apply_scope: "next_startup_policy",
    placeholders: [], required_placeholders: [], max_bytes: 32768, restorable: true,
    scope_kind: "extension", apply_when: "対象 domain に DDD 仕様が登録済み" },
] as const;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function setupFetch(update?: (body: { content: string; expected_revision: string }) => Response,
  uncertainFile = false) {
  let historyInitialized = false;
  let pending = uncertainFile ? { operation_id: "00000000-0000-4000-8000-000000000001", status: "uncertain",
    created_at: 1, failure_reason: "file_outcome_unconfirmed" } : null;
  const fetcher = vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
    const path = String(request);
    if (path === "/v1/harness-rules?all=1") return json({ rules: [] });
    if (path === "/v1/admin/inject-sources") return json({
      workflows: [{ id: "session", label: "セッション", cases: [{ id: "session.startup", label: "起動" }] },
        { id: "rules", label: "規則", cases: [{ id: "file", label: "ファイル" }] }],
      sources,
    });
    if (path.endsWith("/history")) { historyInitialized = true; return json({ versions: [
      { version_id: 2, target_id: sources[0].id, parent_version_id: 1, revision: "newer", content: "second line",
        actor: "unknown", change_kind: "edit", created_at: 2 },
      { version_id: 1, target_id: sources[0].id, parent_version_id: null, revision: "older", content: "first line",
        actor: "unknown", change_kind: "baseline", created_at: 1 },
    ], next_before: null, pending }); }
    if (path.endsWith("/history/file-outcome/resolve") && options?.method === "POST") {
      pending = null;
      return json({ source: { ...sources[2], content: "rule", revision: "resolved", history_version_id: 3 } });
    }
    if (path.endsWith("/history/2")) return json({
      version: { version_id: 2, target_id: sources[0].id, parent_version_id: 1, revision: "newer",
        content: "second line", actor: "unknown", change_kind: "edit", created_at: 2 },
      parent: { version_id: 1, target_id: sources[0].id, parent_version_id: null, revision: "older",
        content: "first line", actor: "unknown", change_kind: "baseline", created_at: 1 },
    });
    if (path.endsWith("/history/2/restore") && options?.method === "POST") return json({ source: {
      ...sources[0], content: "second line", revision: "restored", history_version_id: 3,
    } });
    const id = decodeURIComponent(path.split("/").pop() ?? "");
    const summary = sources.find((source) => source.id === id);
    if (!summary) return json({ error: "unknown_target" }, 404);
    if (options?.method === "PUT") return update?.(JSON.parse(String(options.body))) ?? json({ source: {
      ...summary, content: JSON.parse(String(options.body)).content, revision: "new-revision", history_version_id: 2,
    } });
    return json({ source: { ...summary, content: id === sources[0].id ? "first" : id === sources[1].id ? "second" : "rule", revision: id,
      history_version_id: historyInitialized ? 1 : null } });
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

it("can adopt the version returned by a conflict and save again", async () => {
  let attempts = 0;
  const fetcher = setupFetch((body) => {
    attempts++;
    return attempts === 1
      ? json({ error: "revision_conflict", source: { ...sources[0], content: "external",
        revision: "external-revision", history_version_id: 2 } }, 409)
      : json({ source: { ...sources[0], content: body.content,
        revision: "accepted-revision", history_version_id: 3 } });
  });
  render(<MajorInjectPanel />);
  fireEvent.change(await screen.findByRole("textbox", { name: "本文" }), { target: { value: "first draft" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  fireEvent.click(await screen.findByRole("button", { name: "最新版を読み込む" }));
  fireEvent.change(screen.getByRole("textbox", { name: "本文" }), { target: { value: "revised draft" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(attempts).toBe(2));
  const writes = fetcher.mock.calls.filter(([request, options]) => String(request).endsWith(sources[0].id)
    && options?.method === "PUT");
  expect(JSON.parse(String(writes[1]?.[1]?.body)).expected_version_id).toBe(2);
});

it("shows basic text as always active and an extension with its additive condition", async () => {
  setupFetch();
  render(<MajorInjectPanel />);
  expect(await screen.findByText("区分: 基本（常時適用）")).toBeTruthy();
  const picker = screen.getByLabelText("編集対象") as HTMLSelectElement;
  expect(picker.options[0]?.textContent).toContain("基本 · Session policy");
  expect([...picker.options].find((option) => option.value === sources[3].id)?.textContent)
    .toContain("拡張 · DDD report");
  fireEvent.change(picker, { target: { value: sources[3].id } });
  expect(await screen.findByText("区分: 拡張（条件一致時に基本へ加算）")).toBeTruthy();
  expect(screen.getByText("適用条件: 対象 domain に DDD 仕様が登録済み")).toBeTruthy();
});

it("initializes history before the first edit and sends its version as the save precondition", async () => {
  const fetcher = setupFetch();
  render(<MajorInjectPanel />);
  fireEvent.change(await screen.findByRole("textbox", { name: "本文" }), { target: { value: "first revision" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
    `/v1/admin/inject-sources/${encodeURIComponent(sources[0].id)}`,
    expect.objectContaining({ method: "PUT" }),
  ));
  const write = fetcher.mock.calls.find(([request, options]) => String(request).endsWith(sources[0].id)
    && options?.method === "PUT");
  expect(JSON.parse(String(write?.[1]?.body)).expected_version_id).toBe(1);
});

it("shows version differences and restores a selected version explicitly", async () => {
  const fetcher = setupFetch();
  render(<MajorInjectPanel />);
  await screen.findByRole("textbox", { name: "本文" });
  fireEvent.click(screen.getByRole("button", { name: "履歴を表示・更新" }));
  fireEvent.click(await screen.findByRole("button", { name: /#2 · edit/ }));
  const diff = await screen.findByLabelText("版の差分");
  expect(diff.textContent).toContain("−first line");
  expect(diff.textContent).toContain("+second line");
  fireEvent.click(screen.getByRole("button", { name: "この版を復元" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
    `/v1/admin/inject-sources/${encodeURIComponent(sources[0].id)}/history/2/restore`,
    expect.objectContaining({ method: "POST" }),
  ));
  const restore = fetcher.mock.calls.find(([request, options]) => String(request).endsWith("/history/2/restore")
    && options?.method === "POST");
  expect(JSON.parse(String(restore?.[1]?.body)).expected_version_id).toBe(1);
});

it("requires explicit acceptance for an uncertain file write", async () => {
  const fetcher = setupFetch(undefined, true);
  render(<MajorInjectPanel />);
  fireEvent.change(await screen.findByLabelText("ワークフロー"), { target: { value: "rules" } });
  await screen.findByRole("textbox", { name: "本文" });
  fireEvent.click(screen.getByRole("button", { name: "履歴を表示・更新" }));
  const accept = await screen.findByRole("button", { name: "現ファイルを確認して採用" });
  fireEvent.click(accept);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
    `/v1/admin/inject-sources/${encodeURIComponent(sources[2].id)}/history/file-outcome/resolve`,
    expect.objectContaining({ method: "POST" }),
  ));
});
