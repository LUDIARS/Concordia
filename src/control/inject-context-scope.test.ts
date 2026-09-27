import { describe, expect, it } from "vitest";
import { selectContextScope } from "./inject-context-scope.js";

describe("context scope", () => {
  const links = { praeforma: "http://pf/project", anatomia: "http://an/domain" };
  it("suppresses all additions before a confirmed conversation and binding", () => {
    expect(selectContextScope(false, true, links)).toEqual({ ddd: false, praeforma: "", anatomia: "" });
  });
  it("requires an explicit true DDD setting without coupling Pf and An", () => {
    expect(selectContextScope(true, false, links)).toEqual({ ddd: false, ...links });
    expect(selectContextScope(true, null, links).ddd).toBe(false);
    expect(selectContextScope(true, true, { praeforma: "", anatomia: links.anatomia }))
      .toEqual({ ddd: true, praeforma: "", anatomia: links.anatomia });
  });
});
