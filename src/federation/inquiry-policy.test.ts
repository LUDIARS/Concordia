import { describe, expect, it } from "vitest";
import {
  INQUIRY_ALLOWED_TOOLS,
  INQUIRY_DEFAULT_TIMEOUT_SEC,
  buildInquiryPrompt,
  clampInquiryTimeoutSec,
  decideHqInquiryRoute,
  inquiryClaudeArgs,
  truncateInquiryOutput,
  validateHqInquiryTarget,
} from "./inquiry-policy.js";
import { INQUIRY_MAX_OUTPUT, parseFederationFrame, serializeFederationFrame } from "./protocol.js";

const sites = { active: new Set(["melpot", "aws"]), online: new Set(["melpot"]) };
const ports = {
  isActiveSite: (id: string) => sites.active.has(id),
  isConnected: (id: string) => sites.online.has(id),
};

describe("decideHqInquiryRoute", () => {
  it("runs requests addressed to hq locally", () => {
    expect(decideHqInquiryRoute({ origin: "melpot", target: "hq", fromSite: "melpot", ...ports })).toEqual({ kind: "local" });
  });

  it("forwards to an online active site", () => {
    expect(decideHqInquiryRoute({ origin: "aws", target: "melpot", fromSite: "aws", ...ports })).toEqual({ kind: "forward", siteId: "melpot" });
  });

  it("rejects a spoofed origin", () => {
    expect(decideHqInquiryRoute({ origin: "aws", target: "hq", fromSite: "melpot", ...ports }).kind).toBe("reject");
  });

  it("rejects self, unknown and offline targets", () => {
    expect(decideHqInquiryRoute({ origin: "melpot", target: "melpot", fromSite: "melpot", ...ports }).kind).toBe("reject");
    expect(decideHqInquiryRoute({ origin: "melpot", target: "nowhere", fromSite: "melpot", ...ports }).kind).toBe("reject");
    expect(decideHqInquiryRoute({ origin: "melpot", target: "aws", fromSite: "melpot", ...ports })).toEqual({ kind: "reject", error: "site is offline: aws" });
  });
});

describe("validateHqInquiryTarget", () => {
  it("accepts hq as local and online sites as remote", () => {
    expect(validateHqInquiryTarget({ target: "hq", ...ports })).toEqual({ ok: true, local: true });
    expect(validateHqInquiryTarget({ target: "melpot", ...ports })).toEqual({ ok: true, local: false });
    expect(validateHqInquiryTarget({ target: "aws", ...ports }).ok).toBe(false);
  });
});

describe("read-only execution", () => {
  it("exposes only guarded read tools without inherited MCP or settings", () => {
    expect(INQUIRY_ALLOWED_TOOLS).not.toContain("Edit");
    expect(INQUIRY_ALLOWED_TOOLS).not.toContain("Write");
    expect(INQUIRY_ALLOWED_TOOLS).toEqual(["Read", "Grep", "Glob"]);
    const args = inquiryClaudeArgs("claude-opus-5-5", "guard-settings");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args[args.indexOf("--settings") + 1]).toBe("guard-settings");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Bash");
    expect(args[0]).toBe("-p");
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Write");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("tells the executor it must not change anything", () => {
    const prompt = buildInquiryPrompt({ origin: "hq", prompt: "ログを見て", cwd: "D:/LUDIARS/Concordia" });
    expect(prompt).toContain("変更しないでください");
    expect(prompt.endsWith("ログを見て")).toBe(true);
  });
});

describe("limits", () => {
  it("clamps the timeout", () => {
    expect(clampInquiryTimeoutSec(undefined)).toBe(INQUIRY_DEFAULT_TIMEOUT_SEC);
    expect(clampInquiryTimeoutSec(1)).toBe(30);
    expect(clampInquiryTimeoutSec(10_000)).toBe(600);
  });

  it("truncates long output to the wire limit", () => {
    const out = truncateInquiryOutput("x".repeat(INQUIRY_MAX_OUTPUT + 10));
    expect(out.length).toBe(INQUIRY_MAX_OUTPUT);
    expect(out).toContain("省略");
  });
});

describe("inquiry frames", () => {
  it("round-trips request and result frames", () => {
    const request = parseFederationFrame(serializeFederationFrame({
      type: "inquiry-request", request_id: "r1", origin: "hq", target: "melpot", prompt: "調べて", project: "Concordia", timeout_sec: 60,
    }));
    expect(request.ok && request.frame.type).toBe("inquiry-request");
    const result = parseFederationFrame(serializeFederationFrame({
      type: "inquiry-result", request_id: "r1", ok: true, output: "結果", executed_by: "melpot", duration_ms: 12,
    }));
    expect(result.ok && result.frame.type).toBe("inquiry-result");
  });

  it("rejects a project that escapes the workspace root", () => {
    const parsed = parseFederationFrame(serializeFederationFrame({
      type: "inquiry-request", request_id: "r1", origin: "hq", target: "melpot", prompt: "x", project: "../secret", timeout_sec: 60,
    }));
    expect(parsed.ok).toBe(false);
  });
});
