import { expect, it } from "vitest";
import { sessionCategory } from "./category.js";
it("uses only the authoritative task reference of the linked run", () => {
  expect(sessionCategory('{"delegation_run_id":"r"}', () => ({ args_json: '{"taskflow_reference":"actio:t"}' }))).toBe("taskflow");
  expect(sessionCategory('{"title":"Taskflow"}', () => null)).toBe("conversation");
  expect(sessionCategory('{"delegation_run_id":"r"}', () => ({ args_json: "broken" }))).toBe("conversation");
});
