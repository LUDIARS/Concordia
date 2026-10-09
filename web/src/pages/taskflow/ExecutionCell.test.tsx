// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskflowExecution } from "../../api.js";
import { ExecutionCell } from "./ExecutionCell.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(execution: TaskflowExecution | undefined): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ExecutionCell execution={execution} />));
  return container;
}

const base: TaskflowExecution = {
  state: "working",
  received_at: 1_790_000_000,
  current_action: { label: "Edit", source: "tool", at: 1_790_000_100 },
  last_response: { text: "PR を出しました", at: 1_790_000_200 },
  stop_reason: null,
  artifacts: [
    { kind: "pr", label: "#42 · open", url: "https://github.com/LUDIARS/Concordia/pull/42" },
    { kind: "branch", label: "feat/task", url: null },
  ],
};

describe("ExecutionCell", () => {
  it("shows state, receipt, current action, last response and artifacts", () => {
    const view = render(base);
    expect(view.textContent).toContain("作業中");
    expect(view.textContent).toContain("受領");
    expect(view.textContent).toContain("動作: Edit");
    expect(view.textContent).toContain("最終応答");
    expect(view.textContent).toContain("PR を出しました");
    expect(view.querySelector("a")?.getAttribute("href")).toBe("https://github.com/LUDIARS/Concordia/pull/42");
    expect(view.textContent).toContain("feat/task");
    expect(view.textContent).not.toContain("停止理由");
  });

  it("shows the stop reason when the work stopped", () => {
    const view = render({ ...base, state: "stopped", stop_reason: "子セッションが完了報告の前に終了した" });
    expect(view.textContent).toContain("停止");
    expect(view.textContent).toContain("停止理由: 子セッションが完了報告の前に終了した");
  });

  it("renders a dash when the execution view is missing", () => {
    expect(render(undefined).textContent).toBe("—");
  });
});
