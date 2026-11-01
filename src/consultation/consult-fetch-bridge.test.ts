import { describe, expect, it } from "vitest";
import { consultFetchGuidance, consultFetchMcpArgs } from "./consult-fetch-bridge.js";
import { confinementArgsFor } from "./consult-model.js";
import { consultationToolAllowed } from "./safety-policy.js";

describe("managed Consult public-link capability", () => {
  it("exposes only a fixed stdio tool and inherits Cc-owned identity, never a model path", () => {
    const args = consultFetchMcpArgs();
    expect(args[0]).toBe("-c");
    expect(args[1]).toContain('mcp_servers.consult_fetch_link={command="node"');
    expect(args[1]).toContain('/tools/consult-fetch-mcp.mjs"');
    expect(args[1]).toContain('enabled_tools=["fetch_link"]');
    expect(args[1]).toContain('"CONCORDIA_CONSULT_FETCH_LINK_SCRIPT"');
    expect(args[1]).not.toContain("network_access");
  });
  it("keeps confinement while including the managed bridge even when shell hooks are untrusted", () => {
    const args = confinementArgsFor("codex", [], { codexShell: false })!;
    expect(args).toContain("read-only");
    expect(args).toContain("shell_tool");
    expect(args).toContain("plugins");
    expect(args.indexOf("mcp_servers={}")).toBeLessThan(args.indexOf(consultFetchMcpArgs()[1]!));
    expect(confinementArgsFor("claude", ["--strict-mcp-config"])).toEqual(["--strict-mcp-config"]);
  });
  it("instructs only Codex to substitute the tool for the shared shell recipe", () => {
    expect(consultFetchGuidance("claude")).toBeNull();
    expect(consultFetchGuidance("codex")).toContain("fetch_link");
  });
  it("allows this one managed tool, not arbitrary MCP names", () => {
    expect(consultationToolAllowed("mcp__consult_fetch_link__fetch_link")).toBe(true);
    expect(consultationToolAllowed("mcp__consult_fetch_link__exec")).toBe(false);
    expect(consultationToolAllowed("mcp__other__fetch_link")).toBe(false);
  });
});
