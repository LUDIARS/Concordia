// @vitest-environment jsdom
/** @implements spec/feature/session-message-webui-chat.md — RWF絵文字入力 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatInput } from "./ChatInput.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("inserts a registered emoji at the selection without submitting", async () => {
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("reaction-mappings")
    ? { defaults: { "☀️": "old", "🙏": "ask" }, overrides: { "☀": null }, action_help: {} }
    : { entries: [
      { emoji: "🙏", skill: "ask", label: "確認" },
      { emoji: "❓", skill: "ask", label: "質問" },
    ] })));
  vi.stubGlobal("fetch", fetcher);
  const submit = vi.fn().mockResolvedValue(null);
  render(<ChatInput onSubmit={submit} disabled={false} />);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "前後" } });
  input.setSelectionRange(1, 1);
  fireEvent.click(screen.getByRole("button", { name: "RWF絵文字" }));
  expect(await screen.findByText("/ask")).toBeTruthy();
  expect(screen.getByRole("button", { name: "❓ 質問" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "🙏 確認" }));
  expect(input.value).toBe("前🙏後");
  expect(submit).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.every(([url]) => url.startsWith("/v1/admin/reaction-"))).toBe(true);
});

it("does not offer emoji input for an inactive session", () => {
  render(<ChatInput onSubmit={vi.fn()} disabled />);
  expect((screen.getByRole("button", { name: "RWF絵文字" }) as HTMLButtonElement).disabled).toBe(true);
});
