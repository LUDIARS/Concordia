// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GeneratedScriptsPanel } from "./GeneratedScriptsPanel.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("discards an old repository response after selection changes", async () => {
  let finishOld: (response: Response) => void = () => { throw new Error("old request missing"); };
  const oldResponse = new Promise<Response>(resolve => { finishOld = resolve; });
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.endsWith("/projects")) return Promise.resolve(new Response(JSON.stringify({ projects: [
      { code: "a", project: "Alpha" }, { code: "b", project: "Beta" },
    ] })));
    if (url.endsWith("code=a")) return oldResponse;
    return Promise.resolve(new Response(JSON.stringify({ code: "b", scripts: [{
      id: "new-script", description: "Beta script", arguments: [], requiredPermissions: ["workspace-read"],
      digest: "a".repeat(64), verified: false,
    }] })));
  }));
  render(<GeneratedScriptsPanel query="" />);
  const selector = await screen.findByLabelText("リポジトリ");
  await screen.findByText("生成スクリプトを読み込み中…");
  fireEvent.change(selector, { target: { value: "b" } });
  expect(await screen.findByText("new-script")).toBeTruthy();
  await act(async () => { finishOld(new Response(JSON.stringify({ code: "a", scripts: [{
    id: "old-script", description: "Alpha script", arguments: [], requiredPermissions: ["workspace-write"],
    digest: "b".repeat(64), verified: true,
  }] }))); });
  expect(screen.queryByText("old-script")).toBeNull();
});
