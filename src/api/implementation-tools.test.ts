// @spec 最後に登録した作業プロジェクト
import { expect, it, vi } from "vitest";
import type { ImplementationToolsService } from "../implementation-tools/service.js";
import { implementationToolsRouter } from "./implementation-tools.js";

it("requests policy refresh only after a successful implementation bind", async () => {
  const order: string[] = [];
  const bind = vi.fn(async () => { order.push("bound"); return { ok: true }; });
  const refresh = vi.fn(() => { order.push("refresh"); });
  const app = implementationToolsRouter({
    tools: { bind } as unknown as ImplementationToolsService,
    requestPolicyRefresh: refresh,
  });
  const request = () => app.request("/bind", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: "fixture", cwd: "E:/fixture/worktree", task: "[GLab] fix" }) });
  expect((await request()).status).toBe(200);
  expect(order).toEqual(["bound", "refresh"]);
  expect(refresh).toHaveBeenCalledWith("fixture");
  bind.mockRejectedValueOnce(new Error("invalid repository"));
  expect((await request()).status).toBe(409);
  expect(refresh).toHaveBeenCalledTimes(1);
});
