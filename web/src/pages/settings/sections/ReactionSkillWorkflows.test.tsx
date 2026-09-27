// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReactionSkillWorkflowsPanel } from "./ReactionSkillWorkflows.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function data() {
  return { path: "fixture/workflows.json", entries: [{ emoji: "🧠", skill: "my-existing-skill", mode: "inject" }],
    presets: [{ emoji: "👋", skill: "handoff", mode: "inject", label: "引継ぎ", available: false }],
    skills: [], scanned_at: 1, notes: [] };
}

it("displays missing skills and only installs declarative presets after a click", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(data())))
    .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [], missing_skills: ["handoff"] })))
    .mockResolvedValueOnce(new Response(JSON.stringify(data())));
  vi.stubGlobal("fetch", fetcher);
  render(<ReactionSkillWorkflowsPanel actionOptions={[]} />);
  expect(await screen.findByText(/スキル未導入/)).toBeTruthy();
  expect(screen.getByText("my-existing-skill")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "初期定義を追加（既存を保持）" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(fetcher.mock.calls[1]).toEqual(["/v1/admin/reaction-skill-workflows/presets", { method: "POST" }]);
  expect(fetcher.mock.calls[2][0]).toBe("/v1/admin/reaction-skill-workflows");
  expect(screen.getByText("my-existing-skill")).toBeTruthy();
});

it("keeps existing assignments visible when adding presets fails", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(data())))
    .mockResolvedValueOnce(new Response("", { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  render(<ReactionSkillWorkflowsPanel actionOptions={[]} />);
  await screen.findByText("my-existing-skill");
  fireEvent.click(screen.getByRole("button", { name: "初期定義を追加（既存を保持）" }));
  expect(await screen.findByText("初期定義を追加できません (503)")).toBeTruthy();
  expect(screen.getByText("my-existing-skill")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
