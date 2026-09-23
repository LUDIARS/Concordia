import test from "node:test";
import assert from "node:assert/strict";
import { dispatchHook } from "./concordia-hook-mcp.mjs";

test("MCP adapter returns the CLI hook output byte-for-byte", async () => {
  const ctx = { session_id: "native", tool_input: { command: "git status" } };
  const text = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "復旧" } }) + "\n";
  const result = await dispatchHook({ event: "tool-result", ctx }, async input => {
    assert.equal(input.ctx, ctx);
    assert.equal(input.provider, "codex-cli");
    assert.equal(input.event, "tool-result");
    input.output(text.slice(0, 5));
    input.output(text.slice(5));
  });
  assert.deepEqual(result, { content: [{ type: "text", text }] });
});
test("empty output stays a neutral JSON object", async () => {
  assert.deepEqual(await dispatchHook({ event: "compact", ctx: {} }, async () => {}),
    { content: [{ type: "text", text: "{}" }] });
});
test("unsupported SessionEnd is rejected before dispatch", async () => {
  await assert.rejects(dispatchHook({ event: "session-end", ctx: {} },
    () => assert.fail("must not invoke")), /Unsupported/);
});
test("runtime failure is not reported as a successful observation", async () => {
  await assert.rejects(dispatchHook({ event: "edit", ctx: {} },
    async () => { throw new Error("failed"); }), /failed/);
});

test("registered MCP tool validates events and preserves its wire result", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createHookServer } = await import("./concordia-hook-mcp.mjs");
  const output = '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"review"}}\n';
  const server = createHookServer(async ({ output: write, ctx }) => {
    if (ctx.fail) throw new Error("private error detail");
    write(output);
  });
  const client = new Client({ name: "hook-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "run_hook", arguments: { event: "tool-result", ctx: { session_id: "native" } } });
    assert.deepEqual(result.content, [{ type: "text", text: output }]);
    const invalid = await client.callTool({ name: "run_hook", arguments: { event: "session-end", ctx: {} } });
    assert.equal(invalid.isError, true);
    const failed = await client.callTool({ name: "run_hook", arguments: { event: "edit", ctx: { fail: true } } });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /observation unconfirmed/);
    assert.doesNotMatch(failed.content[0].text, /private error detail/);
  } finally {
    await client.close();
    await server.close();
  }
});
