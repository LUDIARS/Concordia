import { describe, expect, it } from "vitest";
import { parseProjectCodes } from "./project-codes.js";

describe("project code parser", () => {
  it("reads categories and linked projects from the canonical Markdown shape", () => {
    const categories = parseProjectCodes(`
## ゲーム
| Code | Project | 役割 |
|------|---------|------|
| SUPERFAT | [SUPERFAT](https://example.test/SUPERFAT) | game |
| Pa | [Pagus](https://example.test/Pagus) | village |

## 運用ルール
- ignored
`);
    expect(categories).toEqual([
      { name: "ゲーム", entries: [["SUPERFAT", "SUPERFAT"], ["Pa", "Pagus"]] },
    ]);
  });
});
