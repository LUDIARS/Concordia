// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CloudBatchPanel } from "./CloudBatchPanel.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const batch = { batchId: "batch-1", targetId: "target-1", stopped: false, finished: false, lastError: null,
  counts: { running: 1, queued: 2 }, shards: [{ attemptId: "run-1", phase: "running", remoteId: "task_1" }] };

it("lists, inspects and stops only the batch's future dispatch", async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ batches: [batch] }))
    .mockResolvedValueOnce(Response.json(batch))
    .mockResolvedValueOnce(Response.json({ ...batch, stopped: true }));
  vi.stubGlobal("fetch", fetcher);
  render(<CloudBatchPanel sessionId="session-1" />);
  fireEvent.click(screen.getByText("バッチ一覧を更新"));
  fireEvent.click(await screen.findByText("バッチの詳細"));
  expect(await screen.findByText(/run-1 · 実行中 · task_1/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("バッチの追加投入を停止"));
  await waitFor(() => expect(screen.getByText(/batch-1 · target-1 · 追加投入停止/)).toBeInTheDocument());
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    "/v1/delegation/cloud/batches?session_id=session-1",
    "/v1/delegation/cloud/batches/batch-1?session_id=session-1",
    "/v1/delegation/cloud/batches/batch-1/stop",
  ]);
  expect(fetcher.mock.calls[2][1]?.body).toBe(JSON.stringify({ session_id: "session-1" }));
});
