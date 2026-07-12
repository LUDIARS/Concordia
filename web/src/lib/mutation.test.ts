import { describe, expect, it, vi } from "vitest";
import { runMutation } from "./mutation.js";

describe("runMutation", () => {
  it("surfaces API failures and always releases busy state", async () => {
    const busy = vi.fn();
    const error = vi.fn();
    await runMutation({
      setBusy: busy,
      setError: error,
      errorPrefix: "保存失敗: ",
      action: async () => { throw new Error("network down"); },
    });
    expect(busy.mock.calls).toEqual([[true], [false]]);
    expect(error).toHaveBeenLastCalledWith("保存失敗: network down");
  });

  it("runs success cleanup before releasing busy state", async () => {
    const busy = vi.fn();
    const onSuccess = vi.fn();
    const value = await runMutation({
      setBusy: busy,
      setError: vi.fn(),
      action: async () => 42,
      onSuccess,
    });
    expect(value).toBe(42);
    expect(onSuccess).toHaveBeenCalledWith(42);
    expect(busy.mock.calls).toEqual([[true], [false]]);
  });
});
