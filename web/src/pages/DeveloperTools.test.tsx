// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DeveloperTools } from "./DeveloperTools.js";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows preparation and filters capabilities without executing tools", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ location: "Cc HTTP / MCP", tools: [
    { mcp: "concordia_tasks_list", http: "POST /execute", owner: "Actio", preparation: "project binding", effect: "read" },
    { mcp: "concordia_tests_run", http: "POST /execute", owner: "Augur", preparation: "approval", effect: "execute" },
  ], existing: [] })));
  vi.stubGlobal("fetch", fetcher);
  render(<MemoryRouter><DeveloperTools /></MemoryRouter>);
  expect(await screen.findByText("project binding")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("ツールを検索"), { target: { value: "Augur" } });
  expect(screen.queryByText("concordia_tasks_list")).toBeNull();
  expect(screen.getByText("concordia_tests_run")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("/v1/developer-tools/catalog");
});
it("keeps errors visible and allows a read-only retry", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ location: "Cc", tools: [], existing: [] })));
  vi.stubGlobal("fetch", fetcher);
  render(<MemoryRouter><DeveloperTools /></MemoryRouter>);
  expect((await screen.findByRole("alert")).textContent).toContain("503");
  fireEvent.click(screen.getByText("再読込"));
  expect(await screen.findByText("該当するツールはありません。")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
