import { describe, expect, it } from "vitest";
import {
  applicationStackSite,
  describeTaskflowFailureDiagnostics,
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
} from "./failure-diagnostics.js";

describe("taskflow failure diagnostics for unclassified exceptions", () => {
  it("keeps exception type and a redacted single-line message", () => {
    const error = new TypeError("fetch failed: Bearer abc.def token=s3cr3t\nnext line");
    const result = describeTaskflowFailureDiagnostics(error);
    expect(result.error_name).toBe("TypeError");
    expect(result.error_message).not.toContain("abc.def");
    expect(result.error_message).not.toContain("s3cr3t");
    expect(result.error_message).not.toContain("\n");
    expect(result.error_message).toContain("fetch failed");
  });

  it("strips URL queries, absolute paths and caps length", () => {
    const long = `GET http://127.0.0.1:17880/api/tasks?project=x&key=v in E:\\Users\\me\\a.db ${"x".repeat(400)}`;
    const result = describeTaskflowFailureDiagnostics(new Error(long));
    expect(result.error_message).not.toContain("project=x");
    expect(result.error_message).not.toContain("E:\\Users");
    expect(result.error_message.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_MESSAGE_LENGTH + 1);
  });

  it("reports identifier-shaped cause name and code only", () => {
    const cause = Object.assign(new Error("connect timeout to secret-host"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    const result = describeTaskflowFailureDiagnostics(new TypeError("fetch failed", { cause }));
    expect(result).toMatchObject({ cause_name: "Error", cause_code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(JSON.stringify(result)).not.toContain("secret-host");
    const odd = describeTaskflowFailureDiagnostics(new Error("x", { cause: { code: "token=abc" } }));
    expect(odd.cause_code).toBeNull();
  });

  it("describes non-Error values without their content", () => {
    expect(describeTaskflowFailureDiagnostics("secret-token")).toEqual({
      error_name: "non-error:string", error_message: "", error_site: null, cause_name: null, cause_code: null,
    });
    expect(describeTaskflowFailureDiagnostics(null).error_name).toBe("non-error:null");
  });

  it("reduces the first application frame to a repository-relative site", () => {
    const stack = [
      "Error: boom",
      "    at node:internal/process/task_queues:95:5",
      "    at Object.fn (E:\\Document\\Ars\\Concordia\\node_modules\\hono\\dist\\hono.js:1:2)",
      "    at async ActioTaskStore.scan (E:\\Document\\Ars\\Concordia\\dist\\taskflow\\actio-store.js:120:17)",
      "    at E:\\Document\\Ars\\Concordia\\dist\\api\\taskflow.js:70:5",
    ].join("\n");
    expect(applicationStackSite(stack)).toBe("ActioTaskStore.scan @ dist/taskflow/actio-store.js:120:17");
    expect(applicationStackSite("Error: x\n    at file:///home/u/repo/src/api/taskflow.ts:3:4")).toBe("src/api/taskflow.ts:3:4");
    expect(applicationStackSite("Error: x\n    at /opt/elsewhere/index.js:1:1")).toBeNull();
    expect(applicationStackSite(undefined)).toBeNull();
  });

  it("locates the throw site of a real exception inside this repository", () => {
    const site = describeTaskflowFailureDiagnostics(new Error("boom")).error_site;
    expect(site).toMatch(/src\/taskflow\/failure-diagnostics\.test\.ts:\d+:\d+$/);
    expect(site).not.toMatch(/[A-Za-z]:[\\/]/);
  });
});
