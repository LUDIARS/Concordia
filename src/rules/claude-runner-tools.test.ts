import { describe, expect, it } from "vitest";
import { allowedToolArgs } from "./claude-runner.js";
import { notionMcpRunOptions } from "./notion-source-mcp.js";

// claude は起動しない。 引数の組み立てだけを見る。

describe("allowedToolArgs", () => {
  it("keeps only ToolSearch among built-ins so deferred MCP tools can load, and allows only the given tools", () => {
    expect(allowedToolArgs(notionMcpRunOptions().allowedTools)).toEqual([
      "--tools=ToolSearch", "--disable-slash-commands", "--allowedTools",
      "ToolSearch,mcp__claude_ai_Notion__notion-fetch,mcp__claude_ai_Notion__notion-search,mcp__claude_ai_Notion__notion-query-data-sources",
    ]);
  });

  it("removes every built-in tool when no MCP tool is allowed", () => {
    expect(allowedToolArgs(["Read"])).toEqual(["--tools=", "--disable-slash-commands", "--allowedTools", "Read"]);
  });

  it("never skips permissions and drops malformed names", () => {
    const args = allowedToolArgs(["mcp__claude_ai_Notion__notion-fetch", "Bash(rm -rf /)", " "]);
    expect(args).toEqual(["--tools=ToolSearch", "--disable-slash-commands", "--allowedTools", "ToolSearch,mcp__claude_ai_Notion__notion-fetch"]);
    expect(args.join(" ")).not.toContain("dangerously");
    expect(allowedToolArgs([])).toEqual([]);
  });
});
