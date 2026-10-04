import { expect, it } from "vitest";
import { InjectEchoLedger } from "./inject-echo.js";
it("keeps ambiguous identical posts visible even after an undelivered injection", () => {
  const ledger = new InjectEchoLedger();
  ledger.remember(10, "yes", 1); ledger.remember(11, "yes", 2);
  expect(ledger.consume("yes", 3)).toBeNull();
  expect(ledger.consume("yes", 3)).toBeNull();
  expect(ledger.consume("yes", 3)).toBeNull();
  ledger.remember(12, "other", 4);
  expect(ledger.consume("yes", 5)).toBeNull();
  expect(ledger.consume("other", 200)).toBeNull();
});
it("matches a known delivery once without merging an identical unrelated post", () => {
  const ledger = new InjectEchoLedger();
  ledger.remember(1, "same", 1, "delivery-a");
  expect(ledger.consume("same", 2)).toBeNull();
  expect(ledger.consume("same", 2, "delivery-b")).toBeNull();
  expect(ledger.consume("same", 2, "delivery-a")).toBe(1);
  expect(ledger.consume("same", 2, "delivery-a")).toBeNull();
});
