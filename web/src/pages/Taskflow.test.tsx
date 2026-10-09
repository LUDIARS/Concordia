// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamFilterProvider } from "../lib/TeamFilterContext.js";
import { Taskflow } from "./Taskflow.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const task = {
  path: "spec/tasks/one.md", repo_path: "E:/repo", title: "One task", task: "one", project: "Concordia",
  kind: "実装", status: "delegated", created: "2026-10-09", assignee: "Implementer", source_session: "child-1",
  issued_by_session_id: null, working_session_id: null, session_status: "active", parent_session_id: "parent-1",
  child_session_id: "child-1", delegation_run_id: "run-1", delegation_status: "running", team_id: null,
  subsidiary_id: null, pr: null, ci_status: "unknown",
  execution: {
    state: "stopped", received_at: 1_790_000_000, current_action: null, last_response: null,
    stop_reason: "run failed", artifacts: [],
  },
};

describe("Taskflow", () => {
  it("shows the task status and the execution state as separate columns", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith("/v1/taskflow/overview")) {
        return new Response(JSON.stringify({
          generated_at: 1, tasks: [task],
          counts: { total: 1, pending: 0, delegated: 1, done: 0, cancelled: 0, ci_failure: 0, ci_pending: 0 },
        }));
      }
      if (url.startsWith("/v1/subsidiaries")) return new Response(JSON.stringify({ subsidiaries: [] }));
      return new Response(JSON.stringify({ teams: [] }));
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<MemoryRouter><TeamFilterProvider><Taskflow /></TeamFilterProvider></MemoryRouter>);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const headers = [...container.querySelectorAll("th")].map((cell) => cell.textContent);
    expect(headers).toContain("タスク状態");
    expect(headers).toContain("実行状況");
    expect(container.textContent).toContain("担当中");
    expect(container.textContent).toContain("停止理由: run failed");
  });
});
