import { describe, expect, it } from "vitest";
import { ACTIO_CONTENT_FETCH_ATTEMPTS, ACTIO_CONTENT_FETCH_RETRY_SECONDS, ACTIO_CONTENT_FETCH_RULE } from "./actio-content-fetch-rule.js";

describe("ACTIO_CONTENT_FETCH_RULE", () => {
  it("asks the child to retry a transient failure before stopping", () => {
    expect(ACTIO_CONTENT_FETCH_ATTEMPTS).toBeGreaterThan(1);
    expect(ACTIO_CONTENT_FETCH_RULE).toContain(`${ACTIO_CONTENT_FETCH_RETRY_SECONDS} 秒`);
    expect(ACTIO_CONTENT_FETCH_RULE).toContain(`${ACTIO_CONTENT_FETCH_ATTEMPTS} 回`);
    expect(ACTIO_CONTENT_FETCH_RULE).toContain("停止して報告");
  });
});
