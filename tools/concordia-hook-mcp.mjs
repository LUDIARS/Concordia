#!/usr/bin/env node
/** @implements spec/feature/codex-hook-console-free.md */
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runConcordiaHook } from "./concordia-hook-runtime.mjs";

export const MCP_HOOK_EVENTS = ["session-start", "prompt", "edit", "tool-result", "compact", "post-compact"];
export async function dispatchHook({ event, ctx }, run = runConcordiaHook) {
  if (!MCP_HOOK_EVENTS.includes(event)) throw new Error("Unsupported MCP hook event");
  const chunks = [];
  await run({ event, ctx, provider: "codex-cli", output: text => chunks.push(text) });
  return { content: [{ type: "text", text: chunks.join("") || "{}" }] };
}
export function createHookServer(run = runConcordiaHook) {
  const server = new McpServer({ name: "concordia-hooks", version: "1.0.0" });
  server.registerTool("run_hook", {
    description: "Cc lifecycle hook adapter; preserves session selection and reliability context without a per-event shell.",
    inputSchema: { event: z.enum(MCP_HOOK_EVENTS), ctx: z.record(z.unknown()) },
  }, async (input) => {
    try { return await dispatchHook(input, run); }
    catch { return { isError: true, content: [{ type: "text", text: "Cc hook failed; observation unconfirmed." }] }; }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createHookServer().connect(new StdioServerTransport());
}
