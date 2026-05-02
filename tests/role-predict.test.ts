import { describe, it, expect } from "vitest";
import { predictRole } from "../src/role/predict.js";
import type { SessionEventRow } from "../src/shared/types.js";

function ev(kind: string, payload: object = {}, ts = 0, idx = 0): SessionEventRow {
  return { id: idx, session_id: "s", ts, kind, payload: JSON.stringify(payload) };
}

describe("predictRole", () => {
  it("returns 雑用係 default", () => {
    expect(predictRole([])).toBe("雑用係");
  });

  it("detects テスト魂", () => {
    const events: SessionEventRow[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(ev("edit", { file: `tests/foo${i}.test.ts` }));
    }
    expect(predictRole(events)).toBe("テスト魂");
  });

  it("detects インフラ魔導士", () => {
    const events: SessionEventRow[] = [];
    for (let i = 0; i < 8; i++) events.push(ev("tool_call", { tool: "Bash" }));
    expect(predictRole(events)).toBe("インフラ魔導士");
  });

  it("detects アーキテクト先生", () => {
    const events: SessionEventRow[] = [
      ev("edit", { file: "spec/foo.md" }),
      ev("edit", { file: "spec/bar.md" }),
      ev("compact", {}),
      ev("compact", {}),
    ];
    expect(predictRole(events)).toBe("アーキテクト先生");
  });

  it("detects リファクタ職人 with multi-edit on same file", () => {
    const events: SessionEventRow[] = [];
    for (let i = 0; i < 6; i++) events.push(ev("edit", { file: "src/foo.ts" }));
    for (let i = 0; i < 2; i++) events.push(ev("edit", { file: "src/bar.ts" }));
    expect(predictRole(events)).toBe("リファクタ職人");
  });
});
