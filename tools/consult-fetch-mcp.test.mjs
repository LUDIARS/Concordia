import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFetchServer } from "./consult-fetch-mcp.mjs";

it("cancels the request lifetime when its client disconnects", async () => {
  let received;
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const server = createFetchServer(async (_input, { signal }) => {
    received = signal;
    start();
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    return { isError: true, content: [{ type: "text", text: "cancelled" }] };
  });
  const client = new Client({ name: "consult-close-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const result = client.callTool({ name: "fetch_link", arguments: { url: "https://example.notion.site/public" } }).catch(() => null);
    await started;
    await client.close();
    expect(received.aborted).toBe(true);
    await result;
  } finally { await client.close(); await server.close(); }
});

it("exposes only URL-only fetch_link and preserves its response over MCP", async () => {
  const expected = { content: [{ type: "text", text: "資料ここから\n本文\n資料ここまで" }] };
  const dispatch = vi.fn(async () => expected);
  const server = createFetchServer(dispatch);
  const client = new Client({ name: "consult-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(["fetch_link"]);
    const args = { url: "https://example.notion.site/public" };
    expect(await client.callTool({ name: "fetch_link", arguments: args })).toEqual(expected);
    const invalid = await client.callTool({ name: "fetch_link", arguments: { ...args, script: "other.mjs" } });
    expect(invalid.isError).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally { await client.close(); await server.close(); }
});
