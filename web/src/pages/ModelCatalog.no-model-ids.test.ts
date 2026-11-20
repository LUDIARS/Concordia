// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// モデル ID はカタログ (DB) と role-policy だけが持つ。 画面の例示に世代付き ID を書くと古びる
// (spec/feature/model-role-map.md)。
describe("ModelCatalog page", () => {
  it("does not hardcode generation-specific model IDs", () => {
    const source = readFileSync(fileURLToPath(new URL("./ModelCatalog.tsx", import.meta.url)), "utf8");
    expect(source).not.toMatch(/gpt-\d|claude-(?:opus|sonnet|haiku|fable)-\d/);
  });
});
