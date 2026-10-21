import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelTierSelect } from "./ModelTierSelect.js";
describe("Delegation model level choice", () => {
  it("offers the four levels and preserves the explicit-model path", () => {
    const html = renderToStaticMarkup(<ModelTierSelect value="high" onChange={() => undefined} />);
    for (const label of ["超高", "高", "中", "低", "指定モデルを優先"]) expect(html).toContain(label);
    expect(html).toMatch(/value="high"[^>]*selected/);
  });
});
