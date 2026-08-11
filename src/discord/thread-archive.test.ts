import { describe, expect, it, vi } from "vitest";
import { writeKeepingArchiveState, type ArchivableThread } from "./thread-archive.js";

function thread(initiallyArchived: boolean): ArchivableThread & { setArchived: ReturnType<typeof vi.fn> } {
  let target: ArchivableThread & { setArchived: ReturnType<typeof vi.fn> };
  const setArchived = vi.fn(async (archived: boolean) => {
    target.archived = archived;
  });
  target = { archived: initiallyArchived, setArchived };
  return target;
}

describe("writeKeepingArchiveState", () => {
  it("temporarily opens and then re-closes an archived thread", async () => {
    const target = thread(true);
    const write = vi.fn(async () => "written");

    await expect(writeKeepingArchiveState(target, "refresh", write)).resolves.toBe("written");

    expect(target.setArchived.mock.calls).toEqual([[false, "refresh"], [true, "refresh (re-closed)"]]);
    expect(write).toHaveBeenCalledOnce();
    expect(target.archived).toBe(true);
  });

  it("does not change an already-open thread", async () => {
    const target = thread(false);

    await writeKeepingArchiveState(target, "refresh", async () => undefined);

    expect(target.setArchived).not.toHaveBeenCalled();
  });

  it("re-closes the thread when the write fails", async () => {
    const target = thread(true);
    const failure = new Error("write failed");

    await expect(writeKeepingArchiveState(target, "refresh", async () => { throw failure; })).rejects.toBe(failure);

    expect(target.archived).toBe(true);
  });
});
