import { describe, expect, it } from "vitest";
import { allowedToolArgs } from "./claude-runner.js";
import { notionMcpRunOptions } from "./notion-source-mcp.js";

// claude は起動しない。 引数の組み立てだけを見る。

describe("allowedToolArgs", () => {
  it("removes built-in tools and allows only the given tools", () => {
    expect(allowedToolArgs(notionMcpRunOptions().allowedTools)).toEqual([
      "--tools=", "--disable-slash-commands", "--allowedTools", "mcp__claude_ai_Notion__notion-fetch,mcp__claude_ai_Notion__notion-search",
    ]);
  });

  it("never skips permissions and drops malformed names", () => {
    const args = allowedToolArgs(["mcp__claude_ai_Notion__notion-fetch", "Bash(rm -rf /)", " "]);
    expect(args).toEqual(["--tools=", "--disable-slash-commands", "--allowedTools", "mcp__claude_ai_Notion__notion-fetch"]);
    expect(args.join(" ")).not.toContain("dangerously");
    expect(allowedToolArgs([])).toEqual([]);
  });
});
