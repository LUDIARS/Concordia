import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_CHARTER_FILE, CONTROL_DIR_NAME, prepareControlWorkspace, renderControlCharter } from "./charter.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("control charter", () => {
  it("tells the control session which APIs it may use and what it must not do", () => {
    const text = renderControlCharter({ concordiaUrl: "http://127.0.0.1:11111", generation: 2 });
    expect(text).toContain("第 2 世代");
    expect(text).toContain("GET http://127.0.0.1:11111/v1/control/board");
    expect(text).toContain("POST http://127.0.0.1:11111/v1/control/instructions");
    expect(text).toContain("審査ゲートや人間判断待ちを回避させる指示");
  });

  it("writes CONTROL.md into the dedicated workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-control-"));
    dirs.push(root);
    const dir = await prepareControlWorkspace({ workspaceRoot: root, concordiaUrl: "http://x", generation: 1 });
    expect(dir).toBe(join(root, CONTROL_DIR_NAME));
    expect(await readFile(join(dir, CONTROL_CHARTER_FILE), "utf8")).toContain("第 1 世代");
  });
});
