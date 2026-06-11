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

  it("detects 深掘り型 (compactCount >= 3、specFileEdits=0 でアーキテクト先生とバッティングしない)", () => {
    // compactCount=4 → score = 4*2 = 8; specFileEdits=0 なのでアーキテクト先生は 0 点
    const events: SessionEventRow[] = [];
    for (let i = 0; i < 4; i++) events.push(ev("compact", {}));
    expect(predictRole(events)).toBe("深掘り型");
  });

  it("detects スピード狂 (editEvents >= 10、compactCount === 0)", () => {
    // editEvents=12, editsPerFileMax=1 (全て別ファイル) → スピード狂 = 12*0.6 = 7.2
    // リファクタ職人は editsPerFileMax < 3 なので 0 点
    const events: SessionEventRow[] = [];
    for (let i = 0; i < 12; i++) events.push(ev("edit", { file: `src/file${i}.ts` }));
    expect(predictRole(events)).toBe("スピード狂");
  });

  it("detects 規約警察 (lint + format tool_call >= 2)", () => {
    // lint=3 → score = (3+0)*2 = 6
    const events: SessionEventRow[] = [];
    for (let i = 0; i < 3; i++) events.push(ev("tool_call", { tool: "lint" }));
    expect(predictRole(events)).toBe("規約警察");
  });

  it("detects スケッチ屋 (specFileEdits >= 1 && editEvents <= 3)", () => {
    // specFileEdits=2, editEvents=2 → スケッチ屋 = 2*1.5+2 = 5
    // アーキテクト先生 = 2*2 + 0*1.5 = 4 → スケッチ屋が勝つ
    const events: SessionEventRow[] = [
      ev("edit", { file: "spec/overview.md" }),
      ev("edit", { file: "spec/design.md" }),
    ];
    expect(predictRole(events)).toBe("スケッチ屋");
  });

  it("score 競合 (同点): PATTERNS 配列の先頭側が優先される (テスト魂 vs インフラ魔導士)", () => {
    // testFileEdits=3 → テスト魂 score = 3*1.5 = 4.5
    // infraFileEdits=3 → インフラ魔導士 score = 0*0.8 + 3*1.5 = 4.5
    // PATTERNS 配列でテスト魂(index=0) < インフラ魔導士(index=2) → 安定ソートでテスト魂が先頭に残る
    const events: SessionEventRow[] = [];
    for (let i = 0; i < 3; i++) events.push(ev("edit", { file: `tests/a${i}.test.ts` }));
    for (let i = 0; i < 3; i++) events.push(ev("edit", { file: `infra/deploy${i}.yml` }));
    expect(predictRole(events)).toBe("テスト魂");
  });
});
