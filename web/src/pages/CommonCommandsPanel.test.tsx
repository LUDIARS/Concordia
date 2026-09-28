// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CommonCommandsPanel } from "./CommonCommandsPanel.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows source usage and filters locally without invoking an operation", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ commands: [
    { name: "git:unlock", usage: "git:unlock [--repo <path>]", description: "Unlock stale lock" },
    { name: "rv:prs", usage: "rv:prs [--json]", description: "List local PRs" },
  ] })));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<CommonCommandsPanel query="unlock" />);
  expect(await screen.findByText("git:unlock")).toBeTruthy();
  expect(screen.queryByText("rv:prs")).toBeNull();
  view.rerender(<CommonCommandsPanel query="PRs" />);
  expect(screen.getByText("rv:prs")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("/v1/developer-tools/commands");
});
