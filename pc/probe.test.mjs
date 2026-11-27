import { it } from "node:test";
import assert from "node:assert/strict";
import { probe } from "./probe.mjs";

it("reports the final URL, time and hash without emitting the article text", async () => {
  const result = await probe("https://example.org/a", "canalis", async () => ({
    url: "https://example.org/b", title: "Title", hash: "sum", text: "body", fetchedAt: "time"
  }));
  assert.deepEqual(result, { url: "https://example.org/b", title: "Title", hash: "sum", length: 4, fetchedAt: "time" });
});
